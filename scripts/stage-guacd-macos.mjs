#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const version = process.env.GUACAMOLE_SERVER_VERSION || "1.6.0";
const targetTriple = "aarch64-apple-darwin";
const buildRoot = path.resolve(process.env.GUACD_BUILD_DIR || path.join(repoRoot, ".cache", "guacd-macos"));
const sourceUrl =
  process.env.GUACD_SOURCE_URL ||
  `https://archive.apache.org/dist/guacamole/${version}/source/guacamole-server-${version}.tar.gz`;
const expectedSha256 = process.env.GUACD_TARBALL_SHA256;
const binariesDir = path.join(repoRoot, "src-tauri", "binaries");
const resourcesLibDir = path.join(repoRoot, "src-tauri", "resources", "macos", "lib");
const stagedGuacd = path.join(binariesDir, `guacd-${targetTriple}`);
const prefix = path.join(buildRoot, `install-${version}`);
const freerdpPluginDir = path.join(prefix, "lib", "freerdp3");
const sourceDir = path.join(buildRoot, `guacamole-server-${version}`);
const tarball = path.join(buildRoot, `guacamole-server-${version}.tar.gz`);
const forceRebuild = process.env.GUACD_FORCE_REBUILD === "1";
const placeholderMarker = "SSM_COMMANDER_GENERATED_GUACD_PLACEHOLDER";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0) {
    const details = options.capture
      ? `\n${result.stdout || ""}${result.stderr || ""}`.trimEnd()
      : "";
    throw new Error(`${command} ${args.join(" ")} failed${details ? `:${details}` : ""}`);
  }

  return result;
}

function output(command, args, options = {}) {
  return run(command, args, { ...options, capture: true }).stdout.trim();
}

function requireCommand(command) {
  if (!findCommand(command)) {
    throw new Error(`Missing required command: ${command}`);
  }
}

function findCommand(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function brewPrefix(formula) {
  return output("brew", ["--prefix", formula]);
}

function downloadTarball() {
  fs.mkdirSync(buildRoot, { recursive: true });
  if (fs.existsSync(tarball)) {
    return;
  }
  console.log(`Downloading ${sourceUrl}`);
  run("curl", ["--fail", "--location", "--output", tarball, sourceUrl]);
}

function verifyTarball() {
  if (!expectedSha256) {
    console.warn("GUACD_TARBALL_SHA256 is not set; skipping tarball checksum verification.");
    return;
  }

  const digest = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  if (digest !== expectedSha256) {
    throw new Error(`Tarball SHA-256 mismatch. Expected ${expectedSha256}, got ${digest}.`);
  }
}

function unpackSource() {
  fs.rmSync(sourceDir, { recursive: true, force: true });
  run("tar", ["-xzf", tarball, "-C", buildRoot]);
  patchSourceForMacos();
}

function replaceInFile(file, replacements) {
  let contents = fs.readFileSync(file, "utf8");
  for (const [from, to] of replacements) {
    if (!contents.includes(from)) {
      throw new Error(`Expected source fragment not found in ${file}: ${from}`);
    }
    contents = contents.replace(from, to);
  }
  fs.writeFileSync(file, contents);
}

function patchSourceForMacos() {
  const flagSource = path.join(sourceDir, "src", "libguac", "flag.c");
  const rdpHeader = path.join(sourceDir, "src", "protocols", "rdp", "rdp.h");
  const rdpSource = path.join(sourceDir, "src", "protocols", "rdp", "rdp.c");
  const tcpSource = path.join(sourceDir, "src", "libguac", "tcp.c");
  const fipsHeader = path.join(sourceDir, "src", "libguac", "guacamole", "fips.h");
  replaceInFile(flagSource, [
    [
      "    pthread_condattr_setclock(&cond_attr, CLOCK_MONOTONIC);\n",
      "#ifndef __APPLE__\n    pthread_condattr_setclock(&cond_attr, CLOCK_MONOTONIC);\n#endif\n",
    ],
    [
      "    clock_gettime(CLOCK_MONOTONIC, &ts_timeout);\n",
      "#ifdef __APPLE__\n    clock_gettime(CLOCK_REALTIME, &ts_timeout);\n#else\n    clock_gettime(CLOCK_MONOTONIC, &ts_timeout);\n#endif\n",
    ],
  ]);
  replaceInFile(tcpSource, [
    [
      "    int fd = EBADFD;\n",
      "#ifdef EBADFD\n    int fd = EBADFD;\n#else\n    int fd = EBADF;\n#endif\n",
    ],
  ]);
  replaceInFile(rdpHeader, [
    [
      "#include <freerdp/freerdp.h>\n",
      "#include <freerdp/freerdp.h>\n#include <freerdp/version.h>\n",
    ],
  ]);
  replaceInFile(rdpSource, [
    [
      "\n}\n\n#ifdef HAVE_FREERDP_VERIFYCERTIFICATEEX\n",
      "\n}\n\n#if defined(FREERDP_VERSION_MAJOR) && FREERDP_VERSION_MAJOR >= 3\nstatic BOOL rdp_freerdp_authenticate_ex(freerdp* instance, char** username,\n        char** password, char** domain, rdp_auth_reason reason) {\n\n    (void) reason;\n    return rdp_freerdp_authenticate(instance, username, password, domain);\n\n}\n#endif\n\n#ifdef HAVE_FREERDP_VERIFYCERTIFICATEEX\n",
    ],
    [
      "    rdp_inst->PreConnect = rdp_freerdp_pre_connect;\n    rdp_inst->Authenticate = rdp_freerdp_authenticate;\n\n#ifdef HAVE_FREERDP_VERIFYCERTIFICATEEX\n",
      "    rdp_inst->PreConnect = rdp_freerdp_pre_connect;\n#if defined(FREERDP_VERSION_MAJOR) && FREERDP_VERSION_MAJOR >= 3\n    rdp_inst->AuthenticateEx = rdp_freerdp_authenticate_ex;\n#else\n    rdp_inst->Authenticate = rdp_freerdp_authenticate;\n#endif\n\n#ifdef HAVE_FREERDP_VERIFYCERTIFICATEEX\n",
    ],
  ]);
  ensureTrailingNewline(fipsHeader);
}

function ensureTrailingNewline(file) {
  const contents = fs.readFileSync(file);
  if (contents.length === 0 || contents[contents.length - 1] === 0x0a) {
    return;
  }
  fs.appendFileSync(file, "\n");
}

function configureOptions(help) {
  const desired = [
    "--disable-dependency-tracking",
    "--disable-guacenc",
    "--disable-kubernetes",
    "--disable-ssh",
    "--disable-telnet",
    "--disable-vnc",
    "--with-freerdp",
    `--with-freerdp-plugin-dir=${freerdpPluginDir}`,
  ];
  return desired.filter((option) => configureHelpIncludesOption(help, option));
}

function configureHelpIncludesOption(help, option) {
  const flag = option.split("=")[0];
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(=|\\s|$)`).test(help);
}

function buildGuacd() {
  const dependencyPrefixes = ["cairo", "freerdp", "jpeg-turbo", "libpng", "openssl@3", "ossp-uuid"].map((formula) =>
    brewPrefix(formula),
  );
  const opensslPrefix = brewPrefix("openssl@3");
  const pkgConfigPath = [
    ...dependencyPrefixes.map((prefix) => path.join(prefix, "lib", "pkgconfig")),
    process.env.PKG_CONFIG_PATH,
  ]
    .filter(Boolean)
    .join(":");
  const env = {
    ...process.env,
    ac_cv_func_timer_create: "yes",
    PKG_CONFIG: findCommand("pkg-config") || findCommand("pkgconf"),
    PKG_CONFIG_PATH: pkgConfigPath,
    CFLAGS: [
      process.env.CFLAGS,
      "-Wno-error=strict-prototypes",
      "-Wno-error=unused-variable",
      "-Wno-error=unused-but-set-variable",
      "-Wno-error=deprecated-declarations",
    ]
      .filter(Boolean)
      .join(" "),
    CPPFLAGS: [
      process.env.CPPFLAGS,
      "-D_DARWIN_C_SOURCE",
      ...dependencyPrefixes.map((prefix) => `-I${prefix}/include`),
    ]
      .filter(Boolean)
      .join(" "),
    LDFLAGS: [process.env.LDFLAGS, ...dependencyPrefixes.map((prefix) => `-L${prefix}/lib`)]
      .filter(Boolean)
      .join(" "),
  };
  const help = output("./configure", ["--help"], { cwd: sourceDir, env });
  const options = [`--prefix=${prefix}`, ...configureOptions(help)];

  fs.rmSync(prefix, { recursive: true, force: true });
  run("./configure", options, { cwd: sourceDir, env });
  patchGeneratedMakefilesForMacos();
  run("make", [`-j${os.cpus().length}`], { cwd: sourceDir, env });
  run("make", ["install"], { cwd: sourceDir, env });
}

function patchGeneratedMakefilesForMacos() {
  const rdpMakefile = path.join(sourceDir, "src", "protocols", "rdp", "Makefile");
  replaceInFile(rdpMakefile, [
    [
      "freerdp_LTLIBRARIES = \\\n    libguac-common-svc-client.la \\\n    libguacai-client.la\n",
      "freerdp_LTLIBRARIES = \\\n    libguac-common-svc-client.la\n",
    ],
  ]);
}

function installNameLines(file) {
  return output("otool", ["-L", file])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
}

function shouldBundleDependency(dep, forbiddenPrefixes) {
  return (
    path.isAbsolute(dep) &&
    !dep.startsWith("/usr/lib/") &&
    !dep.startsWith("/System/Library/") &&
    forbiddenPrefixes.some((prefix) => dep === prefix || dep.startsWith(`${prefix}/`))
  );
}

function copyDylibClosure(initialFiles, forbiddenPrefixes) {
  const queue = [...initialFiles];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const file = queue.shift();
    for (const dep of installNameLines(file)) {
      if (!shouldBundleDependency(dep, forbiddenPrefixes)) {
        continue;
      }

      const realDep = fs.realpathSync(dep);
      const target = path.join(resourcesLibDir, path.basename(realDep));
      if (!fs.existsSync(target)) {
        fs.copyFileSync(realDep, target);
        fs.chmodSync(target, 0o755);
      }
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
}

function copyProtocolPlugins() {
  const libDir = path.join(prefix, "lib");
  const pluginNames = fs
    .readdirSync(libDir)
    .filter((name) => name.startsWith("libguac") && name.endsWith(".dylib"));

  if (!pluginNames.some((name) => name.includes("client-rdp"))) {
    throw new Error("Built guacamole-server did not produce libguac-client-rdp; RDP support is missing.");
  }

  for (const name of pluginNames) {
    const original = path.join(libDir, name);
    const src = fs.realpathSync(original);
    copyExecutableFile(src, path.join(resourcesLibDir, path.basename(src)));

    const unversioned = path.join(resourcesLibDir, name);
    if (path.basename(src) !== name) {
      copyExecutableFile(src, unversioned);
    }

    if (name.startsWith("libguac-client-") && name.endsWith(".dylib")) {
      copyExecutableFile(src, path.join(resourcesLibDir, name.replace(/\.dylib$/, ".so")));
    }
  }

  if (!fs.existsSync(freerdpPluginDir)) {
    return;
  }

  for (const name of fs.readdirSync(freerdpPluginDir).filter((name) => name.endsWith(".so"))) {
    const src = fs.realpathSync(path.join(freerdpPluginDir, name));
    copyExecutableFile(src, path.join(resourcesLibDir, path.basename(src)));
  }
}

function copyExecutableFile(src, target) {
  fs.copyFileSync(src, target);
  fs.chmodSync(target, 0o755);
}

function rewriteInstallNames(files, forbiddenPrefixes) {
  for (const file of files) {
    const isExecutable = file === stagedGuacd;
    if (!isExecutable) {
      run("install_name_tool", ["-id", `@rpath/${path.basename(file)}`, file]);
    }

    for (const dep of installNameLines(file)) {
      if (!shouldBundleDependency(dep, forbiddenPrefixes)) {
        continue;
      }
      const targetName = path.basename(fs.realpathSync(dep));
      const replacement = isExecutable
        ? `@executable_path/../Resources/lib/${targetName}`
        : `@loader_path/${targetName}`;
      run("install_name_tool", ["-change", dep, replacement, file]);
    }
  }
}

function validateNoHomebrewLinks(files, forbiddenPrefixes) {
  const offenders = [];
  for (const file of files) {
    const linked = output("otool", ["-L", file]);
    for (const prefix of forbiddenPrefixes) {
      if (linked.includes(prefix)) {
        offenders.push(`${file} still links to ${prefix}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`Staged guacd has non-relocatable library paths:\n${offenders.join("\n")}`);
  }
}

function adHocSign(files) {
  for (const file of files) {
    run("codesign", ["--force", "--sign", "-", file]);
  }
}

function verifyStagedGuacd() {
  for (const required of ["libguac-client-rdp.so", "libguac-client-rdp.dylib"]) {
    if (!fs.existsSync(path.join(resourcesLibDir, required))) {
      throw new Error(`Staged guacd is missing required RDP plugin file: ${required}`);
    }
  }

  const tempBundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ssm-guacd-verify-"));
  const macosDir = path.join(tempBundleRoot, "Contents", "MacOS");
  const resourcesDir = path.join(tempBundleRoot, "Contents", "Resources");
  const tempGuacd = path.join(macosDir, "guacd");

  try {
    fs.mkdirSync(macosDir, { recursive: true });
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.copyFileSync(stagedGuacd, tempGuacd);
    fs.chmodSync(tempGuacd, 0o755);
    fs.symlinkSync(resourcesLibDir, path.join(resourcesDir, "lib"));
    run(tempGuacd, ["-v"]);
  } finally {
    fs.rmSync(tempBundleRoot, { recursive: true, force: true });
  }
}

function hasRealStagedGuacd() {
  if (!fs.existsSync(stagedGuacd)) {
    return false;
  }
  return !fs.readFileSync(stagedGuacd, "utf8").includes(placeholderMarker);
}

function canReuseStagedArtifacts() {
  return !forceRebuild && hasRealStagedGuacd() && stagedLibs().length > 0;
}

function tryReuseStagedArtifacts() {
  if (!canReuseStagedArtifacts()) {
    return false;
  }

  try {
    verifyStagedGuacd();
    console.log(`Reusing staged ${stagedGuacd}`);
    console.log(`Reusing staged dylibs in ${resourcesLibDir}`);
    return true;
  } catch (error) {
    console.warn(`Could not reuse staged guacd; rebuilding: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function stageArtifacts() {
  fs.rmSync(resourcesLibDir, { recursive: true, force: true });
  fs.mkdirSync(resourcesLibDir, { recursive: true });
  fs.mkdirSync(binariesDir, { recursive: true });

  const guacdCandidates = [path.join(prefix, "sbin", "guacd"), path.join(prefix, "bin", "guacd")];
  const builtGuacd = guacdCandidates.find((candidate) => fs.existsSync(candidate));
  if (!builtGuacd) {
    throw new Error(`Could not find built guacd at ${guacdCandidates.join(" or ")}`);
  }

  fs.copyFileSync(builtGuacd, stagedGuacd);
  fs.chmodSync(stagedGuacd, 0o755);
  copyProtocolPlugins();

  const brewRoot = output("brew", ["--prefix"]);
  const forbiddenPrefixes = [prefix, brewRoot, "/opt/homebrew", "/usr/local/opt"];
  copyDylibClosure([stagedGuacd, ...stagedMachOs()], forbiddenPrefixes);

  let files = [stagedGuacd, ...stagedMachOs()];
  rewriteInstallNames(files, forbiddenPrefixes);

  files = [stagedGuacd, ...stagedMachOs()];
  validateNoHomebrewLinks(files, forbiddenPrefixes);
  adHocSign([...stagedMachOs(), stagedGuacd]);
  verifyStagedGuacd();
}

function stagedLibs() {
  return stagedResourcesWithExtensions([".dylib"]);
}

function stagedMachOs() {
  return stagedResourcesWithExtensions([".dylib", ".so"]);
}

function stagedResourcesWithExtensions(extensions) {
  if (!fs.existsSync(resourcesLibDir)) {
    return [];
  }
  return fs
    .readdirSync(resourcesLibDir)
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => path.join(resourcesLibDir, name));
}

function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("This script must run on Apple Silicon macOS for aarch64-apple-darwin.");
  }

  if (tryReuseStagedArtifacts()) {
    return;
  }

  for (const command of ["brew", "codesign", "curl", "make", "otool", "install_name_tool"]) {
    requireCommand(command);
  }
  if (!findCommand("pkg-config") && !findCommand("pkgconf")) {
    throw new Error("Missing required command: pkg-config or pkgconf (install Homebrew pkgconf).");
  }

  for (const formula of ["cairo", "freerdp", "jpeg-turbo", "libpng", "openssl@3", "ossp-uuid", "pkgconf"]) {
    brewPrefix(formula);
  }

  downloadTarball();
  verifyTarball();
  unpackSource();
  buildGuacd();
  stageArtifacts();

  console.log(`Staged ${stagedGuacd}`);
  console.log(`Staged dylibs in ${resourcesLibDir}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
