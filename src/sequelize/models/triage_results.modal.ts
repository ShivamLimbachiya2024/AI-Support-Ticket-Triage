import { Table, Model, Column } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type ITriageResult from '../interface/triage_results.interface';

@Table({ tableName: 'triage_results', underscored: true })
export default class TriageResult extends Model implements ITriageResult {
  @Column({ type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true }) declare id: number;
  @Column({ type: DataTypes.BIGINT, allowNull: false }) declare ticket_id: number;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare category: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare priority: string;
  @Column({ type: DataTypes.TEXT, allowNull: false }) declare summary: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare model_name: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare prompt_version: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare source: string;
  @Column({ type: DataTypes.FLOAT, allowNull: true }) declare confidence: number | null;
}
