import { Table, Model, Column } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type ITicketStatusHistory from '../interface/ticket_status_history.interface';

@Table({ tableName: 'ticket_status_history', underscored: true })
export default class TicketStatusHistory extends Model implements ITicketStatusHistory {
  @Column({ type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true }) declare id: number;
  @Column({ type: DataTypes.BIGINT, allowNull: false }) declare ticket_id: number;
  @Column({ type: DataTypes.STRING, allowNull: true }) declare previous_status: string | null;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare new_status: string;
  @Column({ type: DataTypes.TEXT, allowNull: false }) declare reason: string;
  @Column({ type: DataTypes.INTEGER, allowNull: false }) declare retry_count: number;
}
