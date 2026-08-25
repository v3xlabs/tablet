import { type User } from "./user";

export const heading = (user: User): string => user.displayName.toUpperCase();

export const initials = (user: User): string =>
  user.displayName
    .split(" ")
    .map(part => part[0] ?? "")
    .join("");
