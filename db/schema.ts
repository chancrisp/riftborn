import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const scores=sqliteTable('scores',{
 id:text('id').primaryKey(),name:text('name').notNull(),score:integer('score').notNull(),kills:integer('kills').notNull(),wave:integer('wave').notNull(),seconds:integer('seconds').notNull(),createdAt:integer('created_at').notNull()
},table=>[index('idx_scores_ranking').on(table.score,table.wave,table.seconds)]);
