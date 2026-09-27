// Original short oscillator gestures. These are data, not timers or audio nodes.
// Primary: [frequency Hz, duration seconds, waveform, raw gain, end frequency Hz].
// Layer: the same tuple plus delay seconds. Schedule with the existing effects bus.
// Cooldowns apply per type across all emitters, not once per monster or projectile.
export const EXTRA_SOUNDS=Object.freeze({
 stepGrass:[112,.045,'triangle',.019,48],
 stepStone:[228,.05,'triangle',.021,104],
 stepAsh:[76,.065,'sawtooth',.012,37],
 stepMetal:[460,.065,'sine',.019,318],
 stepVoid:[137,.09,'sine',.016,67],
 dashEnd:[420,.085,'triangle',.033,72],
 heartbeat:[56,.095,'sine',.039,39],
 shield:[890,.13,'triangle',.04,1420],
 pickup:[590,.09,'sine',.035,880],
 portal:[147,.64,'triangle',.047,294],
 playerDeath:[174,.62,'sawtooth',.062,35],
 impactStone:[310,.04,'triangle',.025,115],
 fleshHit:[176,.04,'sawtooth',.023,58],

 // Breaths, clicks and short falling calls leave room for existing attack warnings.
 voiceGroan:[93,.43,'triangle',.03,62],
 voiceSkitter:[830,.065,'square',.015,370],
 voiceBile:[118,.19,'triangle',.033,43],
 voiceSniper:[530,.16,'sine',.019,710],
 voiceStorm:[182,.24,'sawtooth',.021,328],
 voiceBrute:[58,.49,'sawtooth',.04,35],
 voiceRevenant:[196,.3,'sawtooth',.031,49],
 voiceHex:[392,.29,'triangle',.024,196],
 voiceBrood:[82,.28,'square',.021,46],
 voiceSplitter:[153,.11,'square',.019,67],

 // World accents are sparse one-shots; meadowWind includes a distant bird chirp.
 meadowBird:[1740,.07,'sine',.012,2380],
 meadowWind:[132,1.08,'triangle',.008,96],
 quarryClank:[382,.28,'triangle',.019,275],
 calderaRumble:[43,1.12,'sine',.023,34],
 citadelBell:[294,.91,'sine',.018,292],
 voidWhisper:[211,.82,'triangle',.01,73],
 uiOpen:[294,.075,'sine',.029,392],
 uiConfirm:[587,.085,'triangle',.035,784],
 uiBack:[392,.07,'sine',.026,262]
});

// At most two additional oscillators. Delay is bounded; nothing can loop itself.
export const EXTRA_LAYERS=Object.freeze({
 stepGrass:[[540,.025,'sawtooth',.004,240,.006]],
 stepMetal:[[1090,.035,'sine',.005,760,.008]],
 stepVoid:[[203,.06,'sine',.005,104,.018]],
 dashEnd:[[96,.045,'sine',.02,42,.025]],
 heartbeat:[[67,.075,'sine',.024,41,.15]],
 shield:[[1440,.08,'sine',.014,2040,.025]],
 pickup:[[880,.095,'sine',.019,1175,.065]],
 portal:[[221,.46,'sine',.021,442,.09],[440,.26,'sine',.012,660,.3]],
 playerDeath:[[87,.74,'triangle',.023,31,.075]],
 impactStone:[[1190,.025,'sine',.006,420,.006]],
 fleshHit:[[73,.045,'sine',.014,36,.008]],
 voiceGroan:[[139,.29,'sine',.009,84,.065]],
 voiceSkitter:[[1160,.045,'triangle',.009,430,.09]],
 voiceBile:[[61,.12,'sine',.012,35,.045]],
 voiceSniper:[[1060,.07,'sine',.005,910,.065]],
 voiceStorm:[[277,.15,'triangle',.01,415,.085]],
 voiceBrute:[[88,.31,'triangle',.013,49,.08]],
 voiceRevenant:[[98,.23,'sine',.012,36,.065]],
 voiceHex:[[416,.31,'sine',.009,207,.055]],
 voiceBrood:[[164,.17,'triangle',.01,92,.08]],
 voiceSplitter:[[233,.095,'triangle',.01,93,.14]],
 meadowBird:[[2120,.055,'sine',.007,2640,.095]],
 meadowWind:[[197,.86,'sine',.004,146,.11],[1860,.075,'sine',.009,2420,.44]],
 quarryClank:[[914,.16,'sine',.008,730,.02]],
 calderaRumble:[[65,.86,'triangle',.008,48,.11]],
 citadelBell:[[699,.68,'sine',.006,697,.018]],
 voidWhisper:[[223,.68,'sine',.006,79,.055]],
 uiConfirm:[[784,.065,'sine',.012,988,.06]]
});

export const EFFECT_GAPS=Object.freeze({
 stepGrass:.28,stepStone:.28,stepAsh:.3,stepMetal:.3,stepVoid:.32,
 dashEnd:.5,heartbeat:1.15,shield:.4,pickup:.16,portal:2,playerDeath:2,
 impactStone:.12,fleshHit:.12,
 voiceGroan:3.8,voiceSkitter:2.8,voiceBile:3.5,voiceSniper:4.8,voiceStorm:4.2,
 voiceBrute:4.5,voiceRevenant:3.8,voiceHex:4.5,voiceBrood:4.8,voiceSplitter:3.2,
 meadowBird:8,meadowWind:9,quarryClank:8,calderaRumble:10,citadelBell:12,voidWhisper:11,
 uiOpen:.12,uiConfirm:.12,uiBack:.12
});

export const ENEMY_VOICES=Object.freeze({
 runner:'voiceGroan',skitter:'voiceSkitter',gunner:'voiceBile',charger:'voiceGroan',
 brute:'voiceBrute',mortar:'voiceBile',sniper:'voiceSniper',leaper:'voiceGroan',
 splitter:'voiceSplitter',stormer:'voiceStorm',revenant:'voiceRevenant',
 hexer:'voiceHex',broodmother:'voiceBrood',ironmaw:'voiceBrute',warden:'voiceHex'
});
export const STEP_SOUNDS=Object.freeze(['stepGrass','stepStone','stepAsh','stepMetal','stepVoid']);
export const AMBIENT_SOUNDS=Object.freeze(['meadowWind','quarryClank','calderaRumble','citadelBell','voidWhisper']);
