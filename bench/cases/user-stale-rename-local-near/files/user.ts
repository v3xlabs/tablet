export type User = {
  id: string;
  displayName: string;
  email: string;
};

export const describe = (user: User): string =>
  `${user.name} <${user.email}>`;

export const anonymise = (user: User): User => ({
  ...user,
  displayName: "anonymous",
  email: "hidden@example.com",
});
