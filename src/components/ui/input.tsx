import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-10 w-full rounded-md bg-surface px-3 text-sm text-fg shadow-(--shadow-border) outline-none transition-[box-shadow] duration-(--motion-quick) ease-(--ease-out) placeholder:text-subtle",
        "focus-visible:shadow-(--shadow-focus)",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
