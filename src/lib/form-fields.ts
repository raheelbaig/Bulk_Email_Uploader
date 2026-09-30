/**
 * Reading HTML form fields whose absence means something.
 *
 * An unticked checkbox submits nothing at all, so on its own a missing key
 * cannot distinguish "the person unticked it" from "this form never had the
 * checkbox" (a different builder step, a crafted request). Forms that render a
 * checkbox therefore also render a hidden companion, `<name>Shown`, and the
 * pair resolves to:
 *
 *   checkbox present            → its submitted value (the caller validates it)
 *   companion only              → 'false' — rendered and deliberately unticked
 *   neither                     → undefined — not part of this submission
 *
 * Lives outside the `'use server'` action modules, which may only export async
 * functions.
 */
export function checkboxShownField(name: string): string {
  return `${name}Shown`;
}

export function readCheckbox(form: FormData, name: string): string | undefined {
  if (form.has(name)) {
    // A duplicated key (crafted request) is ambiguous; hand the caller a value
    // it will not mistake for an explicit "false".
    const values = form.getAll(name);
    if (values.length !== 1) return 'ambiguous';
    const value = values[0];
    return typeof value === 'string' ? value : 'ambiguous';
  }
  if (form.has(checkboxShownField(name))) return 'false';
  return undefined;
}
