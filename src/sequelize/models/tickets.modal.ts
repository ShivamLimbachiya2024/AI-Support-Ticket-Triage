import { Table, Model, Column } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type ITicket from '../interface/tickets.interface';

@Table({ tableName: 'tickets', underscored: true })
export default class Ticket extends Model implements ITicket {
  @Column({ type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true }) declare id: number;
  @Column({ type: DataTypes.BIGINT, allowNull: false }) declare customer_id: number;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare subject: string;
  @Column({ type: DataTypes.TEXT, allowNull: false }) declare body: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare customer_email: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare triage_status: string;
  @Column({ type: DataTypes.TEXT, allowNull: true }) declare status_reason: string | null;
  @Column({ type: DataTypes.STRING, allowNull: true }) declare triage_failure_code: string | null;
  @Column({ type: DataTypes.INTEGER, allowNull: false }) declare retry_count: number;
  @Column({ type: DataTypes.DATE, allowNull: true }) declare last_retry_at: Date | null;
  @Column({ type: DataTypes.DATE, allowNull: true }) declare processing_started_at: Date | null;
  @Column({ type: DataTypes.INTEGER, allowNull: false }) declare processing_attempt: number;
  @Column({ type: DataTypes.BIGINT, allowNull: true }) declare duplicate_of_ticket_id:
    number | null;
  @Column({ type: DataTypes.DATE, allowNull: true }) declare completed_at: Date | null;
}
