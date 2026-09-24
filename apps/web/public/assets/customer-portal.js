import { createCustomerPage } from './portal/customer-page.js';
import { createPortalShell } from './portal/shell.js';

const shell = createPortalShell('customer');
shell.mount(createCustomerPage(shell));
