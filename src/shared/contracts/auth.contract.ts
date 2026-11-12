export type AuthResponse = {
  readonly token: string;
  readonly user: PublicUser;
};

export type Credentials = {
  readonly name: string;
  readonly password: string;
};

export type PublicUser = {
  readonly id: number;
  readonly name: string;
};
