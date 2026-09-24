const METHODS = Object.freeze([
  'claimTicket', 'consumeTicket', 'createBuild', 'createInstallKey', 'createTicket',
  'licenseById', 'recentBuildCount', 'sourceVersionByProductVersion', 'ticketByHash',
]);

export function createBuildAuthorizationRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}
