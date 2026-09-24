import { createHash } from 'node:crypto';
import { invariant } from '../../../../../packages/core/src/errors.js';
import { newId } from '../../../../../packages/core/src/identifiers.js';
import { transaction } from '../../database.js';

const CATEGORIES = new Set(['packaging', 'build', 'install', 'license', 'consulting']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const STATUSES = new Set(['pending', 'processing', 'waiting_customer', 'resolved', 'closed']);
const ADMIN_TRANSITIONS = Object.freeze({
  pending: new Set(['processing', 'waiting_customer', 'resolved', 'closed']),
  processing: new Set(['pending', 'waiting_customer', 'resolved', 'closed']),
  waiting_customer: new Set(['pending', 'processing', 'resolved', 'closed']),
  resolved: new Set(['pending', 'closed']),
  closed: new Set(['pending']),
});
const CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'text/plain', 'application/pdf']);
const EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'txt', 'log', 'pdf']);

export function createSupportService({ database, repository, artifactStore, clock = () => new Date() }) {
  function customerLicense(session) {
    const license = repository.licenseById(session.actor_id);
    invariant(license && license.status === 'active', 'LICENSE_INACTIVE', '授权已停用', 403);
    return license;
  }
  function body(value) {
    const text = String(value ?? '').trim();
    invariant(text.length >= 2 && text.length <= 5000, 'TICKET_BODY_INVALID', '工单内容需为 2 到 5000 个字符');
    return text;
  }
  function closeReason(value, fallback) {
    const reason = String(value ?? '').trim() || fallback;
    invariant(reason.length >= 2 && reason.length <= 500, 'TICKET_CLOSE_REASON_INVALID', '关闭原因需为 2 到 500 个字符');
    return reason;
  }
  function view(ticket, includeInternal = false) {
    if (!ticket) return null;
    const messages = repository.listSupportMessages(ticket.id)
      .filter((message) => includeInternal || message.visibility === 'public')
      .map((message) => ({
        id: message.id, actor_type: message.actor_type,
        actor_name: message.actor_type === 'admin' ? (message.admin_name || '客服') : '客户',
        body: message.body, visibility: message.visibility, created_at: message.created_at,
      }));
    const attachments = repository.listSupportAttachments(ticket.id).map((attachment) => ({
      id: attachment.id, original_name: attachment.original_name, content_type: attachment.content_type,
      size_bytes: attachment.size_bytes, sha256: attachment.sha256, created_at: attachment.created_at,
    }));
    return {
      id: ticket.id, ticket_number: ticket.ticket_number,
      ...(includeInternal ? { license_id: ticket.license_id, customer_ref: ticket.customer_ref, key_prefix: ticket.key_prefix, bound_domain: ticket.bound_domain } : {}),
      build_job_id: ticket.build_job_id, build_version: ticket.build_version, build_status: ticket.build_status,
      category: ticket.category, subject: ticket.subject, priority: ticket.priority, status: ticket.status,
      assigned_admin_id: ticket.assigned_admin_id, assigned_admin_name: ticket.assigned_admin_name,
      created_at: ticket.created_at, updated_at: ticket.updated_at,
      resolved_at: ticket.resolved_at, closed_at: ticket.closed_at,
      closed_by_type: ticket.closed_by_type, close_reason: ticket.close_reason,
      reopened_at: ticket.reopened_at, messages, attachments,
    };
  }
  const service = {
    listCustomerTickets(licenseId) {
      return repository.listSupportTicketsByLicense(licenseId, 100).map((ticket) => view(ticket));
    },
    listAdminTickets() {
      return repository.listSupportTickets(200).map((ticket) => view(ticket, true));
    },
    createCustomerTicket(session, input) {
      const license = customerLicense(session);
      const category = String(input.category ?? '').trim();
      const priority = String(input.priority ?? 'normal').trim();
      const subject = String(input.subject ?? '').trim();
      invariant(CATEGORIES.has(category), 'TICKET_CATEGORY_INVALID', '请选择有效的工单类型');
      invariant(PRIORITIES.has(priority), 'TICKET_PRIORITY_INVALID', '请选择有效的紧急程度');
      invariant(subject.length >= 2 && subject.length <= 120, 'TICKET_SUBJECT_INVALID', '工单标题需为 2 到 120 个字符');
      const buildJobId = String(input.build_job_id ?? '').trim() || null;
      if (buildJobId) {
        const build = repository.buildJobById(buildJobId);
        invariant(build && build.license_id === license.id, 'TICKET_BUILD_INVALID', '关联的构建任务不属于当前授权', 403);
      }
      const now = clock().toISOString();
      const id = newId('tkt');
      const ticket = repository.createSupportTicket({
        id, ticketNumber: `TK-${now.slice(0, 10).replaceAll('-', '')}-${id.slice(-6).toUpperCase()}`,
        licenseId: license.id, buildJobId, category, subject, priority, now,
      });
      repository.addSupportMessage({ ticketId: ticket.id, actorType: 'customer', actorId: license.id, body: body(input.body), now });
      repository.audit({ actorType: 'customer', actorId: license.id, action: 'support_ticket.created', subjectType: 'support_ticket', subjectId: ticket.id,
        metadata: { ticket_number: ticket.ticket_number, category, priority }, now });
      return view(repository.supportTicketById(ticket.id));
    },
    customerTicket(session, id) {
      const license = customerLicense(session);
      const ticket = repository.supportTicketById(id);
      invariant(ticket && ticket.license_id === license.id, 'TICKET_NOT_FOUND', '工单不存在', 404);
      return view(ticket);
    },
    addCustomerTicketMessage(session, id, input) {
      const license = customerLicense(session);
      const ticket = repository.supportTicketById(id);
      invariant(ticket && ticket.license_id === license.id, 'TICKET_NOT_FOUND', '工单不存在', 404);
      invariant(ticket.status !== 'closed', 'TICKET_CLOSED', '工单已关闭，无法继续回复', 409);
      const now = clock().toISOString();
      repository.addSupportMessage({ ticketId: id, actorType: 'customer', actorId: license.id, body: body(input.body), visibility: 'public', now });
      if (ticket.status === 'waiting_customer' || ticket.status === 'resolved') repository.updateSupportTicketStatus(id, 'pending', now);
      repository.audit({ actorType: 'customer', actorId: license.id, action: 'support_ticket.replied', subjectType: 'support_ticket', subjectId: id, now });
      return view(repository.supportTicketById(id));
    },
    closeCustomerTicket(session, id, input = {}) {
      const license = customerLicense(session);
      const ticket = repository.supportTicketById(id);
      invariant(ticket && ticket.license_id === license.id, 'TICKET_NOT_FOUND', '工单不存在', 404);
      invariant(ticket.status !== 'closed', 'TICKET_ALREADY_CLOSED', '工单已经关闭', 409);
      const now = clock().toISOString();
      const reason = closeReason(input.reason, '客户确认问题已处理');
      return transaction(database, () => {
        const closed = repository.updateSupportTicketStatus(id, 'closed', now, { actorType: 'customer', actorId: license.id, reason });
        repository.audit({ actorType: 'customer', actorId: license.id, action: 'support_ticket.closed',
          subjectType: 'support_ticket', subjectId: id, metadata: { reason }, now });
        return view(closed);
      });
    },
    adminTicket(id) {
      const ticket = repository.supportTicketById(id);
      invariant(ticket, 'TICKET_NOT_FOUND', '工单不存在', 404);
      return view(ticket, true);
    },
    updateAdminTicket({ id, status, priority, assignedAdminId, closeReason: closeReasonInput, actorId }) {
      let ticket = repository.supportTicketById(id);
      invariant(ticket, 'TICKET_NOT_FOUND', '工单不存在', 404);
      const now = clock().toISOString();
      return transaction(database, () => {
        let action = 'support_ticket.updated';
        let reason = null;
        if (status !== undefined) {
          invariant(STATUSES.has(status), 'TICKET_STATUS_INVALID', '工单状态无效');
          if (status !== ticket.status) {
            invariant(ADMIN_TRANSITIONS[ticket.status]?.has(status), 'TICKET_STATUS_TRANSITION_INVALID', '不允许执行该工单状态转换', 409);
            if (status === 'closed') { reason = closeReason(closeReasonInput, '管理员确认工单已处理'); action = 'support_ticket.closed'; }
            else if (ticket.status === 'closed') { reason = closeReason(closeReasonInput, '管理员重新打开工单'); action = 'support_ticket.reopened'; }
            ticket = repository.updateSupportTicketStatus(id, status, now, { actorType: 'admin', actorId, reason });
          }
        }
        if (priority !== undefined) {
          invariant(PRIORITIES.has(priority), 'TICKET_PRIORITY_INVALID', '工单优先级无效');
          ticket = repository.updateSupportTicketPriority(id, priority, now);
        }
        if (assignedAdminId !== undefined) {
          const adminId = assignedAdminId || null;
          if (adminId) invariant(repository.adminById(adminId)?.status === 'active', 'TICKET_ASSIGNEE_INVALID', '指派管理员不存在或不可用');
          ticket = repository.assignSupportTicket(id, adminId, now);
        }
        repository.audit({ actorType: 'admin', actorId, action, subjectType: 'support_ticket', subjectId: id,
          metadata: { status: status ?? null, priority: priority ?? null, assigned_admin_id: assignedAdminId ?? null, reason }, now });
        return view(ticket, true);
      });
    },
    addAdminTicketMessage({ id, body: messageBody, visibility = 'public', actorId }) {
      const ticket = repository.supportTicketById(id);
      invariant(ticket, 'TICKET_NOT_FOUND', '工单不存在', 404);
      invariant(ticket.status !== 'closed', 'TICKET_CLOSED', '工单已关闭，无法继续回复', 409);
      invariant(['public', 'internal'].includes(visibility), 'TICKET_VISIBILITY_INVALID', '消息可见范围无效');
      const now = clock().toISOString();
      repository.addSupportMessage({ ticketId: id, actorType: 'admin', actorId, body: body(messageBody), visibility, now });
      if (visibility === 'public' && ticket.status === 'pending') repository.updateSupportTicketStatus(id, 'waiting_customer', now);
      repository.audit({ actorType: 'admin', actorId, action: visibility === 'internal' ? 'support_ticket.noted' : 'support_ticket.replied',
        subjectType: 'support_ticket', subjectId: id, metadata: { visibility }, now });
      return view(repository.supportTicketById(id), true);
    },
    addSupportAttachment({ ticketId, filename, contentType, buffer, actorType, actorId }) {
      const ticket = repository.supportTicketById(ticketId);
      invariant(ticket, 'TICKET_NOT_FOUND', '工单不存在', 404);
      const safeName = String(filename ?? '').trim().replace(/[\\/\0]/g, '_').slice(0, 160);
      const extension = safeName.split('.').pop()?.toLowerCase();
      invariant(safeName && EXTENSIONS.has(extension) && CONTENT_TYPES.has(contentType), 'TICKET_ATTACHMENT_TYPE_INVALID', '仅支持 PNG、JPG、WebP、TXT、LOG、PDF');
      invariant(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= 10 * 1024 * 1024, 'TICKET_ATTACHMENT_SIZE_INVALID', '附件必须小于 10 MB');
      const id = newId('att');
      const storageRef = `support/${ticketId}/${id}`;
      artifactStore.put(storageRef, buffer);
      try {
        const attachment = repository.createSupportAttachment({
          id, ticketId, originalName: safeName, storageRef, contentType, sizeBytes: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex'), now: clock().toISOString(),
        });
        repository.audit({ actorType, actorId, action: 'support_ticket.attachment_added', subjectType: 'support_ticket', subjectId: ticketId,
          metadata: { attachment_id: id, filename: safeName, size: buffer.length }, now: clock().toISOString() });
        return attachment;
      } catch (error) {
        artifactStore.remove(storageRef);
        throw error;
      }
    },
    supportAttachmentForCustomer(session, ticketId, attachmentId) {
      const license = customerLicense(session);
      const ticket = repository.supportTicketById(ticketId);
      const attachment = repository.supportAttachmentById(attachmentId);
      invariant(ticket && ticket.license_id === license.id && attachment?.ticket_id === ticket.id, 'TICKET_ATTACHMENT_NOT_FOUND', '附件不存在', 404);
      return { ...attachment, buffer: artifactStore.read(attachment.storage_ref) };
    },
    supportAttachmentForAdmin(ticketId, attachmentId) {
      const ticket = repository.supportTicketById(ticketId);
      const attachment = repository.supportAttachmentById(attachmentId);
      invariant(ticket && attachment?.ticket_id === ticket.id, 'TICKET_ATTACHMENT_NOT_FOUND', '附件不存在', 404);
      return { ...attachment, buffer: artifactStore.read(attachment.storage_ref) };
    },
  };
  return service;
}
