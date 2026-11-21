export default interface IUser {
  id?: number;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string | null;
  password_hash: string;
  role: string;

  created_at?: Date;
  updated_at?: Date;
  deleted_at?: Date | null;
}
