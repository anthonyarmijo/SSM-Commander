#import <Cocoa/Cocoa.h>

#include <PCSC/winscard.h>
#ifdef INFINITE
#undef INFINITE
#endif
#include <freerdp/client.h>
#include <freerdp/settings.h>
#include <freerdp/settings_keys.h>
#include <stdlib.h>
#include <string.h>

#import "MRDPView.h"
#import "mf_client.h"
#import "mfreerdp.h"
#import "ssmc_freerdp.h"

struct SsmFreerdpSession {
	MRDPView *view;
	rdpContext *context;
	NSView *parent;
};

static void set_error(char **error_message, const char *message)
{
	if (!error_message)
		return;
	*error_message = strdup(message);
}

static const char *security_argument(const char *security_mode)
{
	if (!security_mode || strcmp(security_mode, "auto") == 0)
		return NULL;
	if (strcmp(security_mode, "nla-ext") == 0)
		return "/sec:nla";
	if (strcmp(security_mode, "nla") == 0 || strcmp(security_mode, "tls") == 0 ||
	    strcmp(security_mode, "rdp") == 0)
	{
		static char argument[16];
		snprintf(argument, sizeof(argument), "/sec:%s", security_mode);
		return argument;
	}
	return NULL;
}

// The app keeps the existing RDP credential contract: a domain-qualified user
// arrives as `DOMAIN\\user`.  Command-line parsing normally separates that
// value into FreeRDP_Username and FreeRDP_Domain.  Because this embedder sets
// credentials after parsing its in-memory arguments, do that separation here
// before CredSSP constructs the NLA identity.
static BOOL set_windows_credentials(rdpSettings *settings, const char *username,
	                               const char *password)
{
	const char *value = username ? username : "";
	const char *separator = strrchr(value, '\\');
	BOOL configured = FALSE;
	if (separator && separator != value && separator[1] != '\0')
	{
		char *domain = strndup(value, (size_t)(separator - value));
		if (domain)
		{
			configured = freerdp_settings_set_string(settings, FreeRDP_Username, separator + 1) &&
			             freerdp_settings_set_string(settings, FreeRDP_Domain, domain);
			free(domain);
		}
	}
	else
	{
		configured = freerdp_settings_set_string(settings, FreeRDP_Username, value);
	}
	return configured &&
	       freerdp_settings_set_string(settings, FreeRDP_Password, password ? password : "");
}

SsmFreerdpSession *ssm_freerdp_create(void *parent_view, const char *host, uint16_t port,
	                                  const char *username, const char *password,
	                                  const char *security_mode, bool share_smartcard,
	                                  uint32_t desktop_width, uint32_t desktop_height,
	                                  char **error_message)
{
	if (error_message)
		*error_message = NULL;
	if (!parent_view || !host || port == 0)
	{
		set_error(error_message, "The native RDP view is missing its host or target port.");
		return NULL;
	}

	SsmFreerdpSession *session = calloc(1, sizeof(SsmFreerdpSession));
	if (!session)
	{
		set_error(error_message, "Could not allocate the native RDP session.");
		return NULL;
	}

	RDP_CLIENT_ENTRY_POINTS entry_points = WINPR_C_ARRAY_INIT;
	entry_points.Size = sizeof(entry_points);
	entry_points.Version = RDP_CLIENT_INTERFACE_VERSION;
	if (RdpClientEntry(&entry_points) != 0 ||
	    !(session->context = freerdp_client_context_new(&entry_points)))
	{
		set_error(error_message, "Could not initialize the embedded FreeRDP client.");
		free(session);
		return NULL;
	}

	const char *arguments[7] = { "ssm-commander", NULL, "/cert:ignore", NULL, NULL, NULL, NULL };
	char destination[320];
	snprintf(destination, sizeof(destination), "/v:%s:%u", host, (unsigned int)port);
	arguments[1] = destination;
	int argc = 3;
	const char *security = security_argument(security_mode);
	if (security)
		arguments[argc++] = security;
	if (share_smartcard)
		arguments[argc++] = "/smartcard";

	if (freerdp_client_settings_parse_command_line(session->context->settings, argc,
	                                                (char **)arguments, FALSE) < 0 ||
	    !set_windows_credentials(session->context->settings, username, password) ||
	    !freerdp_settings_set_uint32(session->context->settings, FreeRDP_DesktopWidth,
	                                 desktop_width > 0 ? desktop_width : 1280) ||
	    !freerdp_settings_set_uint32(session->context->settings, FreeRDP_DesktopHeight,
	                                 desktop_height > 0 ? desktop_height : 720))
	{
		set_error(error_message, "Could not configure the embedded FreeRDP connection.");
		freerdp_client_context_free(session->context);
		free(session);
		return NULL;
	}

	session->parent = (NSView *)parent_view;
	session->view = [[MRDPView alloc] initWithFrame:NSMakeRect(0, 0, 1, 1)];
	mfContext *mac_context = (mfContext *)session->context;
	mac_context->view = session->view;
	mac_context->view_ownership = FALSE;
	[session->parent addSubview:session->view positioned:NSWindowAbove relativeTo:nil];

	if (freerdp_client_start(session->context) != 0)
	{
		[session->view removeFromSuperview];
		[session->view release];
		mac_context->view = NULL;
		freerdp_client_context_free(session->context);
		free(session);
		set_error(error_message, "Could not start the embedded FreeRDP connection.");
		return NULL;
	}

	return session;
}

void ssm_freerdp_set_frame(SsmFreerdpSession *session, double x, double y, double width,
	                      double height, bool visible)
{
	if (!session || !session->view || !session->parent)
		return;
	NSRect parent_bounds = [session->parent bounds];
	double native_y = NSHeight(parent_bounds) - y - height;
	[session->view setFrame:NSMakeRect(x, native_y, MAX(width, 1), MAX(height, 1))];
	[session->view setHidden:!visible];
	if (visible)
		[session->parent addSubview:session->view positioned:NSWindowAbove relativeTo:nil];
}

int ssm_freerdp_connection_state(SsmFreerdpSession *session)
{
	if (!session || !session->context || !session->view)
		return -1;
	if ([session->view is_connected])
		return 1;
	mfContext *mac_context = (mfContext *)session->context;
	if (mac_context->common.thread &&
	    WaitForSingleObject(mac_context->common.thread, 0) == WAIT_OBJECT_0)
		return -1;
	return 0;
}

const char *ssm_freerdp_connection_error(SsmFreerdpSession *session)
{
	if (!session || !session->context)
		return "FREERDP_ERROR_NOT_INITIALIZED";
	const UINT32 error = freerdp_get_last_error(session->context);
	if (error == FREERDP_ERROR_SUCCESS)
		return NULL;
	return freerdp_get_last_error_name(error);
}

int ssm_freerdp_smartcard_reader_count(void)
{
	SCARDCONTEXT context = 0;
	DWORD bytes = 0;
	LONG status = SCardEstablishContext(SCARD_SCOPE_USER, NULL, NULL, &context);
	if (status != SCARD_S_SUCCESS)
		return -1;
	status = SCardListReaders(context, NULL, NULL, &bytes);
	if (status != SCARD_S_SUCCESS || bytes == 0)
	{
		SCardReleaseContext(context);
		return 0;
	}
	char *readers = calloc(bytes, sizeof(char));
	if (!readers)
	{
		SCardReleaseContext(context);
		return -1;
	}
	status = SCardListReaders(context, NULL, readers, &bytes);
	int count = 0;
	if (status == SCARD_S_SUCCESS)
	{
		for (char *reader = readers; *reader; reader += strlen(reader) + 1)
			count++;
	}
	free(readers);
	SCardReleaseContext(context);
	return status == SCARD_S_SUCCESS ? count : -1;
}

void ssm_freerdp_destroy(SsmFreerdpSession *session)
{
	if (!session)
		return;
	if (session->context)
	{
		mfContext *mac_context = (mfContext *)session->context;
		freerdp_client_stop(session->context);
		if (session->view)
		{
			[session->view removeFromSuperview];
			[session->view releaseResources];
			[session->view release];
		}
		mac_context->view = NULL;
		freerdp_client_context_free(session->context);
	}
	free(session);
}

void ssm_freerdp_free_string(char *value)
{
	free(value);
}
