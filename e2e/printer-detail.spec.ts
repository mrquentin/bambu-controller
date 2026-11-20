import { card, clickAndConfirm, clickAndDecline, expect, test } from './fixtures.ts';

test.describe('printer page', () => {
  test('pause, then resume the running print', async ({ page, printerId }) => {
    await page.goto(`/#/printer/${printerId}`);
    const job = card(page, 'Print job');
    const status = job.locator('header');
    await expect(status.getByText('Printing', { exact: true })).toBeVisible();
    await expect(job.getByText('Benchy')).toBeVisible();

    await job.getByRole('button', { name: /Pause/ }).click();
    await expect(status.getByText('Paused', { exact: true })).toBeVisible();

    await job.getByRole('button', { name: /Resume/ }).click();
    await expect(status.getByText('Printing', { exact: true })).toBeVisible();
    await expect(job.getByRole('button', { name: /Pause/ })).toBeEnabled();
  });

  test('stop asks for confirmation, then ends the print', async ({ page, printerId }) => {
    await page.goto(`/#/printer/${printerId}`);
    const job = card(page, 'Print job');
    const status = job.locator('header');
    const stop = job.getByRole('button', { name: /\bStop\b/ });
    await expect(stop).toBeEnabled();

    // Declining (native dialog or in-page) keeps the print running.
    await clickAndDecline(page, stop);
    await expect(status.getByText('Printing', { exact: true })).toBeVisible();

    await clickAndConfirm(page, stop);
    await expect(status.getByText('Failed', { exact: true })).toBeVisible();
    await expect(stop).toBeDisabled();
  });

  test('files tab lists the printer storage and uploads a .gcode file', async ({ page, printerId }) => {
    await page.goto(`/#/printer/${printerId}`);
    await page.getByRole('navigation', { name: 'Printer sections' }).getByRole('link', { name: 'Files' }).click();
    await expect(page).toHaveURL(new RegExp(`#/printer/${printerId}/files$`));

    const files = card(page, 'Files');
    await files.getByRole('button', { name: /cache/ }).first().click();
    await expect(files.getByText('Benchy.gcode.3mf')).toBeVisible();
    await expect(files.getByRole('button', { name: 'Print', exact: true })).toBeVisible();

    // Back to the root; wait for its listing (uploads go to the folder shown).
    await files.getByRole('button', { name: '/', exact: true }).click();
    await expect(files.getByRole('button', { name: /📁 cache/ })).toBeVisible();
    await files.getByLabel('Upload').setInputFiles({
      name: 'e2e-cube.gcode',
      mimeType: 'text/plain',
      buffer: Buffer.from('; e2e upload\nG28\nG1 X10 Y10 F3000\n'),
    });
    await expect(page.getByText('Uploaded e2e-cube.gcode')).toBeVisible();
    await expect(files.getByRole('cell', { name: 'e2e-cube.gcode' })).toBeVisible();
  });

  test('history tab shows the current job', async ({ page, printerId }) => {
    await page.goto(`/#/printer/${printerId}/history`);
    const jobs = card(page, 'Jobs');
    // The fixture restarts the job, so the newest Benchy row is the one in progress.
    const row = jobs.getByRole('row').filter({ hasText: 'Benchy' }).filter({ hasText: 'Printing' });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('cell', { name: '18 / 150' })).toBeVisible();
    await expect(page.getByText('Success rate')).toBeVisible();
  });

  test('skip objects dialog lists the objects of the running job', async ({ page, printerId }) => {
    await page.goto(`/#/printer/${printerId}`);
    await card(page, 'Print job').getByRole('button', { name: /Skip objects/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Skip objects' });
    await expect(dialog).toBeVisible();
    for (const name of ['Cube', 'Benchy <v2> & "friends"', 'Tête à 3 pieds', 'Clip']) {
      await expect(dialog.getByRole('checkbox', { name })).toBeVisible();
    }
    await expect(dialog.getByText('0 selected · 4 remaining')).toBeVisible();

    await dialog.getByRole('checkbox', { name: 'Cube' }).check();
    await expect(dialog.getByText('1 selected · 4 remaining')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Skip 1 object/ })).toBeEnabled();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });
});
