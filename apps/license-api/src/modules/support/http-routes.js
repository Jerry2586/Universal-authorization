function attachmentHeaders(securityHeaders, attachment) {
  return {
    ...securityHeaders(attachment.content_type),
    'content-length': attachment.buffer.length,
    'content-disposition': `attachment; filename="${attachment.original_name.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
  };
}

export async function handleSupportHttp({
  method, url, request, response, portal, sessions, readJson, readBuffer,
  respondJson, requireWebSession, securityHeaders,
}) {
  if (method === 'POST' && url.pathname === '/web/customer/tickets') {
    const session = requireWebSession(request, sessions, 'customer', true);
    respondJson(response, 201, portal.createCustomerTicket(session, await readJson(request)));
    return true;
  }

  const customerTicketMatch = url.pathname.match(/^\/web\/customer\/tickets\/([^/]+)$/);
  if (method === 'GET' && customerTicketMatch) {
    const session = requireWebSession(request, sessions, 'customer');
    respondJson(response, 200, portal.customerTicket(session, customerTicketMatch[1]));
    return true;
  }

  const customerMessageMatch = url.pathname.match(/^\/web\/customer\/tickets\/([^/]+)\/messages$/);
  if (method === 'POST' && customerMessageMatch) {
    const session = requireWebSession(request, sessions, 'customer', true);
    respondJson(response, 201, portal.addCustomerTicketMessage(session, customerMessageMatch[1], await readJson(request)));
    return true;
  }

  const customerCloseMatch = url.pathname.match(/^\/web\/customer\/tickets\/([^/]+)\/close$/);
  if (method === 'POST' && customerCloseMatch) {
    const session = requireWebSession(request, sessions, 'customer', true);
    respondJson(response, 200, portal.closeCustomerTicket(session, customerCloseMatch[1], await readJson(request)));
    return true;
  }

  const customerUploadMatch = url.pathname.match(/^\/web\/customer\/tickets\/([^/]+)\/attachments$/);
  if (method === 'POST' && customerUploadMatch) {
    const session = requireWebSession(request, sessions, 'customer', true);
    portal.customerTicket(session, customerUploadMatch[1]);
    const attachment = portal.addSupportAttachment({
      ticketId: customerUploadMatch[1], filename: url.searchParams.get('filename'),
      contentType: String(request.headers['content-type'] ?? '').split(';')[0].trim(),
      buffer: await readBuffer(request, 10 * 1024 * 1024), actorType: 'customer', actorId: session.actor_id,
    });
    respondJson(response, 201, { id: attachment.id, original_name: attachment.original_name, size_bytes: attachment.size_bytes });
    return true;
  }

  const customerDownloadMatch = url.pathname.match(/^\/web\/customer\/tickets\/([^/]+)\/attachments\/([^/]+)$/);
  if (method === 'GET' && customerDownloadMatch) {
    const session = requireWebSession(request, sessions, 'customer');
    const attachment = portal.supportAttachmentForCustomer(session, customerDownloadMatch[1], customerDownloadMatch[2]);
    response.writeHead(200, attachmentHeaders(securityHeaders, attachment));
    response.end(attachment.buffer);
    return true;
  }

  const adminTicketMatch = url.pathname.match(/^\/web\/admin\/tickets\/([^/]+)$/);
  if (method === 'GET' && adminTicketMatch) {
    requireWebSession(request, sessions, 'admin', false, 'ticket.view');
    respondJson(response, 200, portal.adminTicket(adminTicketMatch[1]));
    return true;
  }

  const adminMessageMatch = url.pathname.match(/^\/web\/admin\/tickets\/([^/]+)\/messages$/);
  if (method === 'POST' && adminMessageMatch) {
    const admin = requireWebSession(request, sessions, 'admin', true, 'ticket.manage');
    const body = await readJson(request);
    respondJson(response, 201, portal.addAdminTicketMessage({
      id: adminMessageMatch[1], body: body.body, visibility: body.visibility, actorId: admin.actor_id,
    }));
    return true;
  }

  const adminUpdateMatch = url.pathname.match(/^\/web\/admin\/tickets\/([^/]+)\/update$/);
  if (method === 'POST' && adminUpdateMatch) {
    const admin = requireWebSession(request, sessions, 'admin', true, 'ticket.manage');
    const body = await readJson(request);
    respondJson(response, 200, portal.updateAdminTicket({
      id: adminUpdateMatch[1], status: body.status, priority: body.priority,
      assignedAdminId: body.assigned_admin_id, closeReason: body.close_reason, actorId: admin.actor_id,
    }));
    return true;
  }

  const adminUploadMatch = url.pathname.match(/^\/web\/admin\/tickets\/([^/]+)\/attachments$/);
  if (method === 'POST' && adminUploadMatch) {
    const admin = requireWebSession(request, sessions, 'admin', true, 'ticket.manage');
    portal.adminTicket(adminUploadMatch[1]);
    const attachment = portal.addSupportAttachment({
      ticketId: adminUploadMatch[1], filename: url.searchParams.get('filename'),
      contentType: String(request.headers['content-type'] ?? '').split(';')[0].trim(),
      buffer: await readBuffer(request, 10 * 1024 * 1024), actorType: 'admin', actorId: admin.actor_id,
    });
    respondJson(response, 201, { id: attachment.id, original_name: attachment.original_name, size_bytes: attachment.size_bytes });
    return true;
  }

  const adminDownloadMatch = url.pathname.match(/^\/web\/admin\/tickets\/([^/]+)\/attachments\/([^/]+)$/);
  if (method === 'GET' && adminDownloadMatch) {
    requireWebSession(request, sessions, 'admin', false, 'ticket.view');
    const attachment = portal.supportAttachmentForAdmin(adminDownloadMatch[1], adminDownloadMatch[2]);
    response.writeHead(200, attachmentHeaders(securityHeaders, attachment));
    response.end(attachment.buffer);
    return true;
  }

  return false;
}
