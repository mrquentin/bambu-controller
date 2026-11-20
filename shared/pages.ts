/** Pages of the web app that the server links to (notifications) and the UI routes. */

export const PRINTER_TABS = ['control', 'files', 'history', 'info'] as const;
export type PrinterTab = (typeof PRINTER_TABS)[number];

/** `/#/printer/<id>` shows the control tab; the other tabs and the edit form add a segment. */
export const printerPage = (id: number, page: PrinterTab | 'edit' = 'control') =>
  `/#/printer/${id}${page === 'control' ? '' : `/${page}`}`;
