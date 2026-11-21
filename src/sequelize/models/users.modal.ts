import { Table, Model, Column } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
@Table({ tableName: 'users', underscored: true, paranoid: true })
export default class User extends Model {
  @Column({ type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true }) declare id: number;
  @Column(DataTypes.STRING) declare first_name: string;
  @Column(DataTypes.STRING) declare last_name: string;
  @Column(DataTypes.STRING) declare email: string;
  @Column(DataTypes.STRING) declare phone: string | null;
  @Column(DataTypes.STRING) declare password_hash: string;
  @Column(DataTypes.STRING) declare role: string;
}
