import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export function usePersistentState<T>(
  key: string,
  defaultValue: T,
  hydrate?: (storedValue: unknown, fallbackValue: T) => T,
): [T, Dispatch<SetStateAction<T>>] {
  const resolvedDefault = useMemo(() => defaultValue, [defaultValue]);
  const [state, setState] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (!stored) {
        return resolvedDefault;
      }
      const parsed = JSON.parse(stored) as unknown;
      return hydrate ? hydrate(parsed, resolvedDefault) : (parsed as T);
    } catch {
      return resolvedDefault;
    }
  });

  const wrappedSetState = useCallback<Dispatch<SetStateAction<T>>>(
    (value) => {
      setState((previous) => {
        const next = value instanceof Function ? value(previous) : value;
        window.localStorage.setItem(key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );

  return [state, wrappedSetState];
}
