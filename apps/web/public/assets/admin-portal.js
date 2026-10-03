import { createAdminPage } from './portal/admin-page.js?v=host-report-2';
import { createPortalShell } from './portal/shell.js';

const shell = createPortalShell('admin');
shell.mount(createAdminPage(shell));
