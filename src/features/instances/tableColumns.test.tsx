import { describe, expect, it } from "vitest";
import {
  buildInstanceTableLayout,
  defaultInstanceTableVisibleColumns,
  normalizeInitialInstanceTableVisibleColumns,
  normalizeInstanceTableColumnWidths,
  normalizeInstanceTableVisibleColumns,
  toggleInstanceTableColumn,
} from "./tableColumns";

describe("instance table column preferences", () => {
  it("uses the default visible columns when no preferences are saved", () => {
    expect(normalizeInstanceTableVisibleColumns(undefined)).toEqual(defaultInstanceTableVisibleColumns);
  });

  it("merges partial saved preferences and ignores unknown column ids", () => {
    expect(normalizeInstanceTableVisibleColumns(["state", "privateIp", "unknown", "state"])).toEqual(["state", "privateIp"]);
  });

  it("clamps saved widths to column minimums and ignores invalid entries", () => {
    expect(normalizeInstanceTableColumnWidths({ name: 90, privateIp: 200, unknown: 300, state: Number.NaN })).toEqual({
      name: 110,
      privateIp: 200,
    });
  });

  it("prevents hiding the last visible column", () => {
    expect(toggleInstanceTableColumn(["name"], "name", false)).toEqual(["name"]);
  });

  it("migrates the untouched legacy default column set to the new default", () => {
    expect(normalizeInitialInstanceTableVisibleColumns(["name", "instanceId", "state", "platform", "privateIp"])).toEqual({
      columns: defaultInstanceTableVisibleColumns,
      migrated: true,
    });
  });

  it("preserves the current visible order when adding a column back", () => {
    expect(toggleInstanceTableColumn(["state", "name", "platform", "privateIp"], "instanceId", true)).toEqual([
      "instanceId",
      "state",
      "name",
      "platform",
      "privateIp",
    ]);
  });
});

describe("instance table layout", () => {
  it("returns only the visible headers in the current visible order", () => {
    const layout = buildInstanceTableLayout(["privateIp", "name"], {});

    expect(layout.map((column) => column.definition.label)).toEqual(["Private IP", "Name"]);
  });

  it("applies saved widths to the rendered columns", () => {
    const layout = buildInstanceTableLayout(["name", "instanceId", "state"], { name: 320, state: 50 });

    expect(layout.map((column) => [column.definition.id, column.width])).toEqual([
      ["name", 320],
      ["instanceId", 170],
      ["state", 72],
    ]);
  });

  it("keeps the correct visible column count for loading and empty states", () => {
    const layout = buildInstanceTableLayout(["name", "state", "privateIp", "ssmStatus"], {});

    expect(layout).toHaveLength(4);
  });

  it("shows platform by default", () => {
    expect(defaultInstanceTableVisibleColumns).toEqual(["state", "name", "platform", "privateIp"]);
  });
});
