import { Input } from '@/components/ui/input';

/** Label + input, so every form in the app spaces and labels identically. */
export function Field({
  name,
  label,
  idSuffix,
  type = 'text',
  required = false,
  defaultValue,
  placeholder,
  hint,
  maxLength,
}: {
  name: string;
  label: string;
  /** Appended to the input's id, so the same field can appear more than once on a page. */
  idSuffix?: string;
  type?: string;
  required?: boolean;
  defaultValue?: string | undefined;
  placeholder?: string;
  hint?: string;
  maxLength?: number;
}) {
  const id = idSuffix === undefined ? name : `${name}-${idSuffix}`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {!required && <span className="ml-1 text-xs text-[--color-muted-foreground]">optional</span>}
      </label>
      <Input
        id={id}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue ?? ''}
        {...(placeholder ? { placeholder } : {})}
        {...(maxLength ? { maxLength } : {})}
      />
      {hint !== undefined && <p className="text-xs text-[--color-muted-foreground]">{hint}</p>}
    </div>
  );
}
