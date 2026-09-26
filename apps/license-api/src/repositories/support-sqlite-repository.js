import { newId } from '../../../../packages/core/src/identifiers.js';

export function createSupportSqliteRepository(queries) {
  return Object.freeze({
    supportRead: (ticketId, actorType, actorId) => queries.supportRead.get(ticketId, actorType, actorId)?.message_sequence ?? 0,
    markSupportRead: (ticketId, actorType, actorId, sequence) => queries.markSupportRead.run(ticketId, actorType, actorId, sequence),
    createSupportTicket(values) {
      const id = values.id ?? newId('tkt');
      queries.insertSupportTicket.run(
        id, values.ticketNumber, values.licenseId, values.buildJobId ?? null, values.category,
        values.subject, values.priority ?? 'normal', values.now, values.now,
      );
      return queries.supportTicketById.get(id);
    },
    supportTicketById: (id) => queries.supportTicketById.get(id),
    listSupportTicketsByLicense: (licenseId, limit = 100) => queries.listSupportTicketsByLicense.all(licenseId, limit),
    listSupportTickets: (limit = 200) => queries.listSupportTickets.all(limit),
    addSupportMessage(values) {
      const id = values.id ?? newId('msg');
      queries.insertSupportMessage.run(
        id, values.ticketId, values.actorType, values.actorId ?? null,
        values.body, values.visibility ?? 'public', values.now,
      );
      queries.touchSupportTicket.run(values.now, values.ticketId);
      return queries.listSupportMessages.all(values.ticketId).find((message) => message.id === id);
    },
    listSupportMessages: (ticketId) => queries.listSupportMessages.all(ticketId),
    updateSupportTicketStatus(id, status, now, { actorType = null, actorId = null, reason = null } = {}) {
      queries.updateSupportTicketStatus.run(
        status, now,
        status, now, status,
        status, now,
        status, actorType,
        status, actorId,
        status, reason,
        status, now,
        status, actorId,
        id,
      );
      return queries.supportTicketById.get(id);
    },
    updateSupportTicketPriority(id, priority, now) {
      queries.updateSupportTicketPriority.run(priority, now, id);
      return queries.supportTicketById.get(id);
    },
    assignSupportTicket(id, adminId, now) {
      queries.assignSupportTicket.run(adminId, now, id);
      return queries.supportTicketById.get(id);
    },
    createSupportAttachment(values) {
      const id = values.id ?? newId('att');
      queries.insertSupportAttachment.run(
        id, values.ticketId, values.messageId ?? null, values.originalName, values.storageRef,
        values.contentType, values.sizeBytes, values.sha256, values.visibility ?? 'public',
        values.actorType ?? 'system', values.actorId ?? null, values.now,
      );
      queries.touchSupportTicket.run(values.now, values.ticketId);
      return queries.supportAttachmentById.get(id);
    },
    supportAttachmentById: (id) => queries.supportAttachmentById.get(id),
    listSupportAttachments: (ticketId) => queries.listSupportAttachments.all(ticketId),
  });
}
