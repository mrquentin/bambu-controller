import { ADMIN, card, expect, test } from './fixtures.ts';

test('change password shows validation errors and keeps the old password', async ({ page }) => {
  await page.goto('/#/settings');
  const form = card(page, 'Change password');
  await expect(form).toBeVisible();
  const current = form.getByLabel('Current password');
  const next = form.getByLabel('New password', { exact: true });
  const confirm = form.getByLabel('Confirm new password');
  const submit = form.getByRole('button', { name: 'Change password' });

  // Mismatch: caught in the browser.
  await current.fill(ADMIN.password);
  await next.fill('Another-Secret-123');
  await confirm.fill('Another-Secret-124');
  await submit.click();
  await expect(page.getByText('New passwords do not match')).toBeVisible();

  // Too weak: rejected by the server's password policy.
  await next.fill('aaaaaaaaaaaa');
  await confirm.fill('aaaaaaaaaaaa');
  await submit.click();
  await expect(page.getByText(/Use at least 3 of: lowercase, uppercase, digits, symbols/)).toBeVisible();

  // Wrong current password.
  await current.fill('Not-The-Password-1');
  await next.fill('Another-Secret-123');
  await confirm.fill('Another-Secret-123');
  await submit.click();
  await expect(page.getByText('Current password is incorrect')).toBeVisible();

  // Nothing changed: the session is still valid.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
});
