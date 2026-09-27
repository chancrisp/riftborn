import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const scores=sqliteTable('scores',{
 id:text('id').primaryKey(),name:text('name').notNull(),score:integer('score').notNull(),kills:integer('kills').notNull(),wave:integer('wave').notNull(),seconds:integer('seconds').notNull(),createdAt:integer('created_at').notNull(),stage:integer('stage'),playedAt:integer('played_at'),deathMode:integer('death_mode',{mode:'boolean'}),statueCount:integer('statue_count'),statueModifier:integer('statue_modifier'),outcome:text('outcome'),gameplayVersion:text('gameplay_version')
},table=>[index('idx_scores_ranking').on(table.score,table.wave,table.seconds),index('idx_scores_mode_version').on(table.deathMode,table.gameplayVersion,table.score,table.wave,table.seconds)]);
