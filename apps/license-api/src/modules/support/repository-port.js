export function createSupportRepositoryPort(repository) {
  return Object.freeze({
    supportRead: repository.supportRead,
    markSupportRead: repository.markSupportRead,
    licenseById: repository.licenseById,
    buildJobById: repository.buildJobById,
    adminById: repository.adminById,
    createSupportTicket: repository.createSupportTicket,
    supportTicketById: repository.supportTicketById,
    listSupportTickets: repository.listSupportTickets,
    listSupportTicketsByLicense: repository.listSupportTicketsByLicense,
    addSupportMessage: repository.addSupportMessage,
    listSupportMessages: repository.listSupportMessages,
    updateSupportTicketStatus: repository.updateSupportTicketStatus,
    updateSupportTicketPriority: repository.updateSupportTicketPriority,
    assignSupportTicket: repository.assignSupportTicket,
    createSupportAttachment: repository.createSupportAttachment,
    supportAttachmentById: repository.supportAttachmentById,
    listSupportAttachments: repository.listSupportAttachments,
    audit: repository.audit,
  });
}
