import { createAdminPage } from './portal/admin-page.js';
import { createPortalShell } from './portal/shell.js';

const shell = createPortalShell('admin');
shell.mount(createAdminPage(shell));
