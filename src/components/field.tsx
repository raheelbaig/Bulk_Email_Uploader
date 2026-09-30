import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** The label row, help text and message slot shared by every form control. */
export function FieldShell({
  id,
  label,
  required = false,
  description,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: React.ReactNode;
  required?: boolean;
  /** What the field is for. Shown between the label and the control. */
  description?: React.ReactNode;
  /** A short note under the control (format, limits). */
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {!required && <span className="ml-1.5 text-xs font-normal text-(--color-muted-foreground)">Optional</span>}
      </label>
      {description !== undefined && (
        <p id={`${id}-description`} className="-mt-0.5 text-sm text-(--color-muted-foreground)">
          {description}
        </p>
      )}
      {children}
      {error !== undefined && error !== null && (
        <p id={`${id}-error`} className="text-sm text-(--color-danger-foreground)">
          {error}
        </p>
      )}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-(--color-muted-foreground)">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Label + input, so every form in the app spaces and labels identically. */
export function Field({
  name,
  label,
  idSuffix,
  type = 'text',
  required = false,
  defaultValue,
  placeholder,
  description,
  hint,
  maxLength,
  autoComplete,
  className,
}: {
  name: string;
  label: string;
  /** Appended to the input's id, so the same field can appear more than once on a page. */
  idSuffix?: string;
  type?: string;
  required?: boolean;
  defaultValue?: string | undefined;
  placeholder?: string;
  description?: string;
  hint?: string;
  maxLength?: number;
  autoComplete?: string;
  className?: string;
}) {
  const id = idSuffix === undefined ? name : `${name}-${idSuffix}`;
  const describedBy = [description !== undefined && `${id}-description`, hint !== undefined && `${id}-hint`]
    .filter(Boolean)
    .join(' ');

  return (
    <FieldShell
      id={id}
      label={label}
      required={required}
      description={description}
      hint={hint}
      {...(className !== undefined ? { className } : {})}
    >
      <Input
        id={id}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue ?? ''}
        {...(describedBy.length > 0 ? { 'aria-describedby': describedBy } : {})}
        {...(placeholder ? { placeholder } : {})}
        {...(maxLength ? { maxLength } : {})}
        {...(autoComplete ? { autoComplete } : {})}
      />
    </FieldShell>
  );
}
