const METHODS = Object.freeze([
  'claimTicket', 'consumeTicket', 'createBuild', 'createInstallKey', 'createTicket',
  'licenseById', 'recentBuildCount', 'sourceVersionByProductVersion', 'ticketByHash', 'totalBuildCount',
]);

export function createBuildAuthorizationRepositoryPort(repository) {
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, repository[name]])));
}
