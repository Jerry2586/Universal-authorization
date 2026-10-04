import { createAdminPage } from './portal/admin-page.js?v=business-1.2.70';
import { createPortalShell } from './portal/shell.js';

const shell = createPortalShell('admin');
shell.mount(createAdminPage(shell));
