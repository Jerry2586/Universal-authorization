import { createAdminPage } from './portal/admin-page.js?v=security-console-1.2.69';
import { createPortalShell } from './portal/shell.js';

const shell = createPortalShell('admin');
shell.mount(createAdminPage(shell));
