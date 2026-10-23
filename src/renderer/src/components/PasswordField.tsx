// Campo de contraseña con "Mostrar" (aria-pressed, docs/DESIGN.md §14.3). Sin autocompletado ni
// corrector; la contraseña nunca se recorta.
import { useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { Button } from './Button';
import { TextField } from './TextField';

export interface PasswordFieldProps extends Omit<
  ComponentPropsWithRef<'input'>,
  'type' | 'id' | 'value' | 'onChange'
> {
  label: string;
  value: string;
  onValueChange(value: string): void;
  hint?: ReactNode;
  error?: string | null;
  autoComplete?: 'current-password' | 'new-password';
}

export function PasswordField({
  label,
  value,
  onValueChange,
  hint,
  error,
  autoComplete = 'current-password',
  ...input
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      {...input}
      label={label}
      hint={hint}
      error={error}
      type={visible ? 'text' : 'password'}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      autoComplete={autoComplete}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      trailing={
        <Button
          size="md"
          variant="ghost"
          className="shrink-0"
          aria-pressed={visible}
          aria-label={`Mostrar ${label.toLowerCase()}`}
          onClick={() => setVisible((v) => !v)}
        >
          Mostrar
        </Button>
      }
    />
  );
}
