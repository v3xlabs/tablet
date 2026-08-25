import { type User } from "./user";

export const heading = (user: User): string => user.name.toUpperCase();

export const initials = (user: User): string =>
  user.name
    .split(" ")
    .map(part => part[0] ?? "")
    .join("");
