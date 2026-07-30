import { useEffect, useId, useRef, useState } from "react";

import { tryUnlockWatchmanDeveloperMode } from "../../watchmanDeveloperMode";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function WatchmanDeveloperUnlockDialog(props: {
  open: boolean;
  onUnlocked: () => void;
  onCancel: () => void;
}) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!props.open) {
      setPasscode("");
      setError(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [props.open]);

  const selectInput = () => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onCancel();
        }
      }}
    >
      <DialogPopup className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Developer passcode</DialogTitle>
          <DialogDescription>
            Enter the passcode to use Watchman Developer on this device. You&apos;ll only be asked
            once here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (tryUnlockWatchmanDeveloperMode(passcode)) {
                setError(null);
                props.onUnlocked();
                return;
              }
              setError("Wrong passcode.");
              selectInput();
            }}
          >
            <Input
              ref={inputRef}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              aria-label="Developer passcode"
              autoComplete="off"
              inputMode="numeric"
              name="watchman-developer-passcode"
              type="password"
              value={passcode}
              onChange={(event) => {
                setPasscode(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
            />
            {error ? (
              <p id={errorId} className="mt-2 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button form={formId} type="submit">
            Unlock
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
