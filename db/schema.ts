import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const scores=sqliteTable('scores',{
 id:text('id').primaryKey(),name:text('name').notNull(),score:integer('score').notNull(),kills:integer('kills').notNull(),wave:integer('wave').notNull(),seconds:integer('seconds').notNull(),createdAt:integer('created_at').notNull(),stage:integer('stage'),playedAt:integer('played_at'),deathMode:integer('death_mode',{mode:'boolean'}),statueCount:integer('statue_count'),statueModifier:integer('statue_modifier'),outcome:text('outcome'),gameplayVersion:text('gameplay_version'),
 // Release the run was played on ("2.1.0") and a KEEPERS run's Rift Score. Production gets these
 // lazily from server/scores-api.js (its database is out of reach of migrations).
 gameVersion:text('game_version'),riftScore:integer('rift_score')
},table=>[index('idx_scores_ranking').on(table.score,table.wave,table.seconds),index('idx_scores_mode_version').on(table.deathMode,table.gameplayVersion,table.score,table.wave,table.seconds)]);
// Player feedback from the game's FEEDBACK form (server/feedback-api.js). No IPs are stored.
export const feedback=sqliteTable('feedback',{
 id:text('id').primaryKey(),createdAt:integer('created_at').notNull(),category:text('category').notNull(),rating:integer('rating'),message:text('message').notNull(),contact:text('contact'),contextJson:text('context_json'),source:text('source').notNull(),build:text('build'),status:text('status').notNull().default('new')
},table=>[index('idx_feedback_created').on(table.createdAt,table.id),index('idx_feedback_status_created').on(table.status,table.createdAt)]);
