import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

type FieldProps = {
  label?: ReactNode;
  hint?: ReactNode;
  /** Error message; sets aria-invalid and renders below the control. */
  error?: ReactNode;
  wrapperClassName?: string;
};

export type InputProps = InputHTMLAttributes<HTMLInputElement> &
  FieldProps & {
    leading?: ReactNode;
    trailing?: ReactNode;
  };

export const inputClassName =
  "control-target h-10 w-full min-w-0 rounded-ctl border border-control-boundary bg-card px-3 text-md text-ink shadow-none transition-colors " +
  "placeholder:text-mute hover:border-mute focus:border-accent focus-ring " +
  "disabled:opacity-60 disabled:bg-desk aria-invalid:border-danger";

function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: FieldProps & { id: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-mute">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, wrapperClassName, leading, trailing, className, id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const control = (
    <input
      ref={ref}
      id={id}
      aria-invalid={error ? true : rest["aria-invalid"]}
      aria-describedby={describedBy ?? rest["aria-describedby"]}
      className={cn(inputClassName, leading && "pl-9", trailing && "pr-9", className)}
      {...rest}
    />
  );
  return (
    <Field id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      {leading || trailing ? (
        <div className="relative">
          {leading ? (
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-mute [&>svg]:size-4">
              {leading}
            </span>
          ) : null}
          {control}
          {trailing ? <span className="absolute inset-y-0 right-2 flex items-center text-mute">{trailing}</span> : null}
        </div>
      ) : (
        control
      )}
    </Field>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, wrapperClassName, className, id: idProp, rows = 4, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <Field id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        aria-invalid={error ? true : rest["aria-invalid"]}
        aria-describedby={describedBy ?? rest["aria-describedby"]}
        className={cn(inputClassName, "h-auto resize-y py-2 leading-relaxed", className)}
        {...rest}
      />
    </Field>
  );
});
