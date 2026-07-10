#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct SsmFreerdpSession SsmFreerdpSession;

SsmFreerdpSession *ssm_freerdp_create(void *parent_view, const char *host, uint16_t port,
                                      const char *username, const char *password,
                                      const char *security_mode, bool share_smartcard,
                                      uint32_t desktop_width, uint32_t desktop_height,
                                      char **error_message);
void ssm_freerdp_set_frame(SsmFreerdpSession *session, double x, double y, double width,
                           double height, bool visible);
int ssm_freerdp_connection_state(SsmFreerdpSession *session);
const char *ssm_freerdp_connection_error(SsmFreerdpSession *session);
int ssm_freerdp_smartcard_reader_count(void);
void ssm_freerdp_destroy(SsmFreerdpSession *session);
void ssm_freerdp_free_string(char *value);
