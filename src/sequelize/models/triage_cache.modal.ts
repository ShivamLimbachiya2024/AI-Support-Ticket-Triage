import { Table, Model, Column } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type ITriageCache from '../interface/triage_cache.interface';

@Table({ tableName: 'triage_cache', underscored: true })
export default class TriageCache extends Model implements ITriageCache {
  @Column({ type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true }) declare id: number;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare text_hash: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare model_name: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare prompt_version: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare category: string;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare priority: string;
  @Column({ type: DataTypes.TEXT, allowNull: false }) declare summary: string;
  @Column({ type: DataTypes.FLOAT, allowNull: true }) declare confidence: number | null;
}
