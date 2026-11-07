/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat mascots: draggable Live2D chibi companions beside the composer.
 *
 * This file is loaded before chatView.js and exposes window.ZCodeMascots.
 * Everything heavy (pixi + Cubism core + live2d-display, ~800 KB) is fetched
 * only after the user turns mascots on. The layer is event-transparent except
 * for one hit-proxy div per character, so the background picker and the
 * composer keep working underneath.
 *
 * Interactions: eye blink and the subtle breathing sway come from the model
 * itself (the looping idle body-bob motion is disabled). While the pointer
 * rests on a character the head and eyes ease toward it, then settle back
 * once it leaves. A fidget timer plays one-shot motions. Models that ship
 * Idle/TapBody keep those; about half the fidgets use a shared set of human
 * motions — nod, shake, smile, wave — retargeted onto the parameter ids and
 * ranges that model actually has. Models with no motion files use only that
 * shared set (nothing is written into the model).
 * A click reads a zone (the model's own hit area when it has one, otherwise
 * head / body / feet by height; the outer edges of the head count as ears),
 * plays a matching gesture, and pops one gift. Two quick clicks are a
 * signal, three a flurry, five a gift storm. Holding still pets; a long
 * hold melts. A fast flick throws them: a neighbour can catch them, the
 * walls and ceiling answer, and three throws in a short span leave them
 * dizzy until a pet or a rest. A slower drop picks one place or pair gag
 * (hug, stack, hand-hold, and the rest of the table below). A fast pointer
 * a still pointer gets a stare. Quiet time
 * daydreams, yawns, then dozes. Gag lines are local so they show on release.
 * Task dispatch and completion trigger a reaction via ZCodeMascots.react(), and
 * after a long silence a mascot speaks up. Spoken lines are asked of GLM Flash
 * (ZCodeMascots.onSpeak); the lists below are what she says if that call is
 * skipped or does not come back.
 */
(function () {
	'use strict';

	/** Fallback on-screen height (CSS px) when the state carries no size. */
	var DEFAULT_SIZE_PX = 300;
	/** Absolute clamp for the size slider. */
	var SIZE_MIN_PX = 140;
	var SIZE_MAX_PX = 1000;
	/** Share of a default-queued model that sinks below the viewport bottom
	 *  (clipped by the fold), so the visible part focuses on the upper body.
	 *  Dragged models sit wherever they were dropped and are not sunk. */
	var OVERHANG = 0.35;
	/** Seconds a bubble stays on screen. */
	var BUBBLE_SECONDS = 2600;
	/** Idle chatter: min/max seconds of inactivity before a line. */
	var CHATTER_MIN_MS = 4 * 60 * 1000;
	var CHATTER_MAX_MS = 9 * 60 * 1000;
	var TAP_LINES = [
		'在忙什么呀？',
		'这个 bug 交给我！',
		'嗯嗯，我在听～',
		'别点啦，好痒！',
		'今天也要加油鸭！',
		'让我看看你写的代码',
		'摸鱼要适度哦',
		'喝水了吗？',
		'又熬夜写代码了？',
		'嗯！这个思路可以！',
	];
	/** Lines keyed by where the pointer landed. Body reuses the general set. */
	var ZONE_LINES = {
		head: ['别点头啦，好痒', '头发要被你点乱了', '摸头可以，轻一点', '嗯？我在看你写代码'],
		ear: ['耳朵很敏感的！', '别揪耳朵啦', '耳朵要抖起来了'],
		foot: ['脚好痒！', '你碰到裙摆了', '别闹我的脚'],
	};
	/** Three clicks inside this window turn into one bigger reaction. */
	var TAP_COMBO_MS = 1300;
	var COMBO_LINES = ['连点三下，心都要被你戳出来了', '好好好，我在我在', '再点我要害羞了'];
	/** A press that stays inside the drag threshold this long is a pet. */
	var PET_HOLD_MS = 420;
	var PET_LINES = ['按着不放是在摸头吗', '嗯……这样很舒服', '再摸下去要化掉了', '呼噜呼噜'];
	/** A release faster than this (px/ms, |vx|+|vy|) is a throw, not a drop. */
	var TOSS_SPEED = 0.85;
	var TOSS_LINES = ['哇，飞起来了', '放我下来！', '落地了，有点晕', '再甩一次？', '好高！'];
	var NUZZLE_LINES = ['贴贴', '靠这么近呀', '你挤到我了', '嗯，一起站着'];
	var NUZZLE_REPLIES = ['贴贴', '别挤啦', '这样也挺好', '嗯，我让一让'];
	/** Quiet this long and one mascot nods off. */
	var DOZE_AFTER_MS = 80 * 1000;
	var HEARTS = ['💗', '💖', '✨', '🌸'];
	var SPARKS = {
		head: ['💗', '✨', '🌸'],
		ear: ['✨', '💫', '💗'],
		body: ['⭐', '✨', '🎵'],
		foot: ['💫', '🫧', '🍀'],
	};
	/** One gift per click. The bubble sometimes quotes the gift. */
	var GIFTS = [
		{ glyph: '☕', line: '咖啡分我一口？' },
		{ glyph: '🍪', line: '饼干！我先咬一口' },
		{ glyph: '📖', line: '又要看书了吗' },
		{ glyph: '🐟', line: '鱼！这个我喜欢' },
		{ glyph: '⭐', line: '送我一颗星星呀' },
		{ glyph: '🎵', line: '要给我唱歌吗' },
		{ glyph: '🍀', line: '四叶草，好运加一' },
		{ glyph: '🧋', line: '奶茶！今天辛苦了' },
		{ glyph: '💡', line: '灵光一现！' },
	];
	var CHATTER_LINES = [
		'发什么呆呀，写点东西～',
		'我在这里等你哦',
		'喝了口水吗？休息一下眼睛吧',
		'窗口开这么多，记得保存呀',
		'悄悄说：Enter 就能发送哦',
	];
	/** Fidget: one-shot motions from these groups play at random intervals. */
	var FIDGET_GROUPS = ['Idle', 'TapBody', 'Tap', 'Shake'];
	/** Fidget cadence: min/max wait between two one-shot motions. */
	var FIDGET_MIN_MS = 9000;
	var FIDGET_MAX_MS = 22000;
	/** MotionPriority.FORCE — task reactions override an in-flight fidget. */
	var MOTION_FORCE = 3;
	/** Reactions closer than this are swallowed (busy flags can flicker). */
	var REACT_COOLDOWN_MS = 8000;

	var DISPATCH_LINES = [
		'任务派出去咯！',
		'收到新活儿，开工～',
		'这次要做什么呀？',
		'我来盯着，放心！',
		'冲鸭！',
	];
	var COMPLETE_LINES = [
		'搞定一个任务！',
		'漂亮！又完成一个',
		'收工～喝口水',
		'稳，下一题！',
		'干得漂亮！',
	];
	/** Local gags. Each id is one interaction in the play set. */
	var GAGS = {
		double: { motion: 'tilt', glyphs: ['✨', '❓'], lines: ['两下是暗号吗', '再点一下试试', '双击收到'] },
		storm: { motion: 'wave', glyphs: ['🎁', '✨', '💖'], count: 10, lines: ['礼物太多啦', '我接不住了', '谢谢谢谢谢谢'] },
		popLine: { motion: 'shake', glyphs: ['💬', '✨'], lines: ['别戳我的话', '这句话会害羞', '你点到台词了'] },
		melt: { motion: 'smile', glyphs: ['💗', '🫠'], lines: ['再摸要化掉了', '手心好暖', '呼噜声变大了'] },
		again: { motion: 'lean', glyphs: ['💗'], lines: ['再摸一会儿嘛', '手怎么拿开了', '还没摸够'] },
				blow: { motion: 'ears', glyphs: ['💨', '🌸'], lines: ['好痒，别吹气', '头发要被你吹乱', '呼——好凉'] },
		stare: { motion: 'tilt', glyphs: ['👀', '✨'], lines: ['你一直在看我', '看代码，别看我', '再看我要脸红了'] },
		leave: { motion: 'lean', glyphs: ['👋'], lines: ['你走啦', '回头看一眼嘛', '我还在这儿'] },
		tossLand: { motion: 'shake', glyphs: ['✨', '💫'], lines: TOSS_LINES },
		catch: { motion: 'wave', glyphs: ['⭐', '✨', '💫'], count: 6, catcherFirst: true, lines: ['接住啦', '好险，差点飞走', '我接住你了'], replies: ['谢啦', '下次轻一点', '腿还软着'] },
		bump: { motion: 'shake', glyphs: ['💥', '💫'], lines: ['撞到了', '看着点路', '好痛呀'], replies: ['你才撞我', '站稳啦', '哎哟'] },
		wall: { motion: 'shake', glyphs: ['💥'], lines: ['撞墙了', '这面墙好硬', '哎哟'] },
		ceil: { motion: 'shake', glyphs: ['💫'], lines: ['碰到天花板了', '头好晕', '上面没路'] },
		boing: { motion: 'wave', glyphs: ['✨', '🏀'], lines: ['蹦', '地板有弹性', '再高一点'] },
		fly: { motion: 'wave', glyphs: ['🚀', '✨'], lines: ['要飞出屏幕了', '拉我一把', '世界这么大'] },
		dizzy: { motion: 'shake', glyphs: ['💫', '⭐', '🌀'], count: 6, lines: ['我晕了，先缓缓', '星星在转', '别再甩了'] },
		stillDizzy: { motion: 'shake', glyphs: ['💫'], lines: ['还晕着，甩不动', '让我缓缓', '头还在转'] },
		undizzy: { motion: 'smile', glyphs: ['💗', '✨'], lines: ['好多了', '头不转了', '又能玩了'] },
		place: { motion: 'nod', glyphs: ['✨'], lines: ['放这儿吧', '这个位置可以', '我站好了'] },
		high: { motion: 'wave', glyphs: ['🌤️', '✨'], lines: ['好高呀', '上面看得远', '别松手'] },
		crouch: { motion: 'lean', glyphs: ['🌱'], lines: ['蹲下来了', '下面好安静', '我趴一会儿'] },
		wallHug: { motion: 'lean', glyphs: ['🧱'], lines: ['靠墙站着', '墙凉凉的', '这里能躲一下'] },
		corner: { motion: 'tilt', glyphs: ['🌙'], lines: ['角落好安静', '我就躲这儿', '谁也别找我'] },
		desk: { motion: 'lean', glyphs: ['⌨️', '✨'], lines: ['我趴在输入框上看你', '字要打在我旁边', '让一让键盘'] },
		peek: { motion: 'look', glyphs: ['👀'], lines: ['探出头来看看', '输入框边上刚好', '只露一个头'] },
		spin: { motion: 'shake', glyphs: ['🌀', '💫'], count: 6, lines: ['转圈圈', '世界在转', '再转我要倒了'] },
		wiggle: { motion: 'shake', glyphs: ['✨'], lines: ['别晃我', '左右摇好晕', '你在抖什么'] },
		hopdrag: { motion: 'wave', glyphs: ['✨'], lines: ['上上下下', '把我当球拍了', '颠得头发乱了'] },
		nuzzle: { motion: 'smile', glyphs: HEARTS, count: 6, lines: NUZZLE_LINES, replies: NUZZLE_REPLIES },
		hug: { motion: 'smile', glyphs: HEARTS, count: 8, lines: ['抱紧', '好暖和', '别松'], replies: ['抱紧', '喘不过气啦', '再近一点'] },
		stack: { motion: 'shake', glyphs: ['✨', '📦'], count: 5, lines: ['上面看得远', '我在头顶', '别倒呀'], replies: ['好重啊', '站稳一点', '头发要被你坐扁'] },
		gaze: { motion: 'look', glyphs: ['👀', '✨'], lines: ['在看你', '对视三秒', '你先眨眼'], replies: ['我没眨眼', '看回去', '你好呀'] },
		hand: { motion: 'wave', glyphs: ['🤝', '✨'], lines: ['牵手', '手伸过来', '一起走'], replies: ['牵着', '别甩开', '手心热热的'] },
		five: { motion: 'wave', glyphs: ['✋', '✨', '⭐'], count: 5, lines: ['击掌', '啪', '配合不错'], replies: ['啪', '好响', '再来一次'] },
		taller: { motion: 'tilt', glyphs: ['📏', '✨'], lines: ['我高一点', '上面风景好', '你要垫脚吗'], replies: ['那我看腿长', '身高不是全部', '哼'] },
		steal: { motion: 'shake', glyphs: ['🚩'], lines: ['这是我的位置', '你站我脚上了', '挪一挪'], replies: ['我不走', '一起站', '挤挤也好'] },
		pass: { motion: 'talk', glyphs: ['📨', '✨'], lines: ['帮我传句话', '你告诉旁边那位', '悄悄说'], replies: ['收到啦', '我听到了', '传达到了'] },
		queue: { motion: 'nod', glyphs: ['🔢', '✨'], lines: ['我们排队', '队伍整齐', '下一个是谁'], replies: ['排好了', '别插队', '我站这儿'] },
		squeeze: { motion: 'lean', glyphs: ['✨'], lines: ['中间好挤', '两边让一让', '我被夹住了'], replies: ['别挤我', '往旁边一点', '呼吸困难'] },
		brush: { motion: 'look', glyphs: ['💨', '✨'], lines: ['擦肩而过', '差一点就抱住', '风吹过去了'], replies: ['你从我身边过去了', '慢一点', '刚才是你吗'] },
		home: { motion: 'wave', glyphs: ['🏠', '✨'], lines: ['我回来了', '回到输入框旁边', '到家了'] },
		wake: { motion: 'wave', glyphs: ['☀️', '✨'], lines: ['醒了，伸个懒腰', '再睡五分钟嘛', '我起来了'] },
		wokenBy: { motion: 'tilt', glyphs: ['💤', '✨'], lines: ['吵到我了', '谁叫我', '梦还没做完'] },
		yawn: { motion: 'doze', glyphs: ['🥱'], lines: ['哈啊——', '有点困了', '眼睛睁不开'] },
		daze: { motion: 'look', glyphs: ['💭', '✨'], lines: ['在发呆', '代码会自己长出来吗', '望着远处'] },
		typing: { motion: 'nod', glyphs: ['⌨️', '✨'], lines: ['在写呢，我看着', '这个字我认识', '慢慢写，不急'] },
		grow: { motion: 'wave', glyphs: ['✨'], lines: ['我变大了', '再大就要顶到天花板', '看得更清楚'] },
		shrink: { motion: 'lean', glyphs: ['✨'], lines: ['我变小了', '再小就要找不到了', '小小的也挺好'] },
		hello: { motion: 'wave', glyphs: ['👋', '✨'], lines: ['你来啦', '我在这儿', '今天写点什么'] },
		midnight: { motion: 'doze', glyphs: ['🌙'], lines: ['这么晚还在写', '星星都睡了', '要不要喝口水'] },
		morning: { motion: 'wave', glyphs: ['🌅', '✨'], lines: ['早安', '新的一天', '先保存再开工'] },
		noon: { motion: 'nod', glyphs: ['🍚'], lines: ['午安', '吃饭了吗', '中场休息'] },
		tea: { motion: 'smile', glyphs: ['🍵', '✨'], lines: ['下午茶时间', '配一杯热的', '摸鱼合法时段'] },
		evening: { motion: 'look', glyphs: ['🌆'], lines: ['傍晚了', '天色暗下来了', '灯记得开'] },
		night: { motion: 'doze', glyphs: ['🌛'], lines: ['晚安的点到了', '今天收工吧', '梦里没有 bug'] },
		friday: { motion: 'wave', glyphs: ['🎉', '✨'], lines: ['周五啦', '再撑一下', '周末在招手'] },
		weekend: { motion: 'smile', glyphs: ['🎈', '✨'], lines: ['周末还在写呀', '给你加颗糖', '休息也行的'] },
	};

	/**
	 * Shared one-shot motions for any humanoid model.
	 *
	 * A keyframe value is not a raw parameter number. It is a fraction of the
	 * distance from that parameter's default to its own max (positive) or min
	 * (negative). The same nod is therefore ±30° on a standard head and ±10°
	 * on a model whose head only goes that far. Curves whose id the model
	 * does not have are dropped.
	 *
	 * Ids are listed per body part because the same part is not the same
	 * string: official samples use ParamAngleX, Wanko uses PARAM_ANGLE_X,
	 * and arms split three ways (ParamArmRA ≈ ±1 on Haru but ≈ ±10 on
	 * Hiyori, PARAM_Arm_RT_Angle on the Azur Lane rigs, ParamArmR01 on
	 * Ren/Rice). The first id the model actually has wins, then the fraction
	 * is scaled by that parameter's min/max.
	 *
	 * Hair, scarves, and Wanko's ears are physics outputs — the head motion
	 * already swings them, and a curve would be overwritten before draw.
	 * Fox ears (ParamFoxearL/R) and ParamTail are pose params, so they get
	 * their own clip; models without those ids skip the clip.
	 *
	 * Motions in an unnamed group (the game rips) are not in Idle/TapBody,
	 * so the player never saw them. touch_/main_/a few head clips are
	 * fetched and played once, with Loop forced off — several of those
	 * files loop, which is the bob this view already turns off.
	 */
	var SHARED_MOTIONS = [
		{
			id: 'nod',
			parts: [
				{ ids: ['ParamAngleY', 'PARAM_ANGLE_Y'], keys: [[0, 0], [0.22, -0.42], [0.42, 0], [0.62, -0.26], [0.95, 0]] },
				{ ids: ['ParamAngleZ', 'PARAM_ANGLE_Z'], keys: [[0, 0], [0.3, 0.1], [0.95, 0]] },
				{ ids: ['ParamBodyAngleY', 'PARAM_BODY_ANGLE_Y'], keys: [[0, 0], [0.28, -0.28], [0.9, 0]] },
				{ ids: ['ParamBodyAngleX', 'PARAM_BODY_ANGLE_X'], keys: [[0, 0], [0.35, 0.1], [0.95, 0]] },
			],
		},
		{
			id: 'shake',
			parts: [
				{ ids: ['ParamAngleX', 'PARAM_ANGLE_X'], keys: [[0, 0], [0.22, -0.4], [0.48, 0.4], [0.74, -0.2], [1.05, 0]] },
				{ ids: ['ParamBodyAngleZ', 'PARAM_BODY_ANGLE_Z'], keys: [[0, 0], [0.28, -0.22], [0.55, 0.22], [0.95, 0]] },
				{ ids: ['ParamEyeBallX', 'PARAM_EYE_BALL_X'], keys: [[0, 0], [0.22, -0.35], [0.48, 0.35], [0.74, -0.15], [1.05, 0]] },
			],
		},
		{
			id: 'tilt',
			parts: [
				{ ids: ['ParamAngleZ', 'PARAM_ANGLE_Z'], keys: [[0, 0], [0.4, 0.5], [0.9, 0.5], [1.25, 0]] },
				{ ids: ['ParamBodyAngleZ', 'PARAM_BODY_ANGLE_Z'], keys: [[0, 0], [0.45, 0.32], [1.15, 0]] },
				{ ids: ['ParamEyeBallX', 'PARAM_EYE_BALL_X'], keys: [[0, 0], [0.4, 0.22], [1.15, 0]] },
				{ ids: ['ParamBrowLY', 'PARAM_BROW_L_Y'], keys: [[0, 0], [0.4, 0.28], [1.15, 0]] },
				{ ids: ['ParamBrowRY', 'PARAM_BROW_R_Y'], keys: [[0, 0], [0.4, 0.12], [1.15, 0]] },
			],
		},
		{
			id: 'smile',
			parts: [
				{ ids: ['ParamEyeLSmile', 'PARAM_EYE_L_SMILE'], keys: [[0, 0], [0.3, 0.8], [1.05, 0.8], [1.45, 0]] },
				{ ids: ['ParamEyeRSmile', 'PARAM_EYE_R_SMILE'], keys: [[0, 0], [0.3, 0.8], [1.05, 0.8], [1.45, 0]] },
				{ ids: ['ParamMouthForm', 'PARAM_MOUTH_FORM'], keys: [[0, 0], [0.28, 0.65], [1.1, 0.65], [1.45, 0]] },
				{ ids: ['ParamCheek', 'PARAM_CHEEK', 'PARAM_Smile_eye'], keys: [[0, 0], [0.35, 0.5], [1.15, 0.5], [1.5, 0]] },
				{ ids: ['ParamBrowLY', 'PARAM_BROW_L_Y'], keys: [[0, 0], [0.3, 0.22], [1.25, 0]] },
				{ ids: ['ParamBrowRY', 'PARAM_BROW_R_Y'], keys: [[0, 0], [0.3, 0.22], [1.25, 0]] },
				{ ids: ['ParamAngleZ', 'PARAM_ANGLE_Z'], keys: [[0, 0], [0.4, 0.16], [1.3, 0]] },
			],
		},
		{
			id: 'look',
			parts: [
				{ ids: ['ParamAngleX', 'PARAM_ANGLE_X'], keys: [[0, 0], [0.4, -0.38], [1.0, -0.38], [1.4, 0]] },
				{ ids: ['ParamEyeBallX', 'PARAM_EYE_BALL_X'], keys: [[0, 0], [0.35, -0.5], [1.05, -0.5], [1.4, 0]] },
				{ ids: ['ParamBodyAngleX', 'PARAM_BODY_ANGLE_X'], keys: [[0, 0], [0.45, -0.28], [1.2, 0]] },
				{ ids: ['ParamAngleZ', 'PARAM_ANGLE_Z'], keys: [[0, 0], [0.45, -0.12], [1.3, 0]] },
			],
		},
		{
			id: 'wave',
			parts: [
				{ ids: ['ParamArmRA', 'ParamArmR01', 'PARAM_Arm_RT_Angle', 'ParamArmAR01'], keys: [[0, 0], [0.28, 0.65], [0.48, 0.3], [0.68, 0.7], [0.9, 0.18], [1.2, 0]] },
				{ ids: ['ParamArmRB', 'PARAM_Arm_RB_Agle', 'ParamArmR02'], keys: [[0, 0], [0.3, 0.4], [0.7, 0.45], [1.15, 0]] },
				{ ids: ['ParamArmLA', 'ParamArmL01', 'PARAM_Arm_LT_Angle', 'ParamArmAL01'], keys: [[0, 0], [0.35, 0.12], [1.1, 0]] },
				{ ids: ['ParamAngleZ', 'PARAM_ANGLE_Z'], keys: [[0, 0], [0.35, 0.2], [1.1, 0]] },
				{ ids: ['ParamAngleX', 'PARAM_ANGLE_X'], keys: [[0, 0], [0.35, 0.14], [1.1, 0]] },
				{ ids: ['ParamMouthForm', 'PARAM_MOUTH_FORM'], keys: [[0, 0], [0.3, 0.35], [1.05, 0]] },
			],
		},
		{
			id: 'talk',
			parts: [
				{ ids: ['ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y'], keys: [[0, 0], [0.12, 0.4], [0.24, 0.05], [0.38, 0.55], [0.52, 0.08], [0.66, 0.35], [0.9, 0]] },
				{ ids: ['ParamMouthForm', 'PARAM_MOUTH_FORM'], keys: [[0, 0], [0.2, 0.22], [0.85, 0]] },
				{ ids: ['ParamBrowLY', 'PARAM_BROW_L_Y'], keys: [[0, 0], [0.3, 0.18], [0.85, 0]] },
				{ ids: ['ParamBrowRY', 'PARAM_BROW_R_Y'], keys: [[0, 0], [0.3, 0.18], [0.85, 0]] },
			],
		},
		{
			id: 'lean',
			parts: [
				{ ids: ['ParamBodyAngleX', 'PARAM_BODY_ANGLE_X'], keys: [[0, 0], [0.45, 0.38], [1.0, 0.38], [1.4, 0]] },
				{ ids: ['ParamBodyAngleZ', 'PARAM_BODY_ANGLE_Z'], keys: [[0, 0], [0.45, 0.32], [1.2, 0]] },
				{ ids: ['ParamAngleZ', 'PARAM_ANGLE_Z'], keys: [[0, 0], [0.4, 0.28], [1.2, 0]] },
				{ ids: ['ParamAngleX', 'PARAM_ANGLE_X'], keys: [[0, 0], [0.4, 0.18], [1.2, 0]] },
				{ ids: ['ParamLeftShoulderUp'], keys: [[0, 0], [0.4, 0.28], [1.15, 0]] },
				{ ids: ['ParamRightShoulderUp'], keys: [[0, 0], [0.4, -0.08], [1.15, 0]] },
			],
		},
		{
			id: 'blink',
			fadeIn: 0.04,
			fadeOut: 0.08,
			parts: [
				{ ids: ['ParamEyeLOpen', 'PARAM_EYE_L_OPEN'], keys: [[0, 0], [0.1, -0.92], [0.18, -0.92], [0.34, 0]] },
				{ ids: ['ParamEyeROpen', 'PARAM_EYE_R_OPEN'], keys: [[0, 0], [0.1, -0.92], [0.18, -0.92], [0.34, 0]] },
			],
		},
		{
			id: 'doze',
			fadeIn: 0.35,
			fadeOut: 0.45,
			parts: [
				{ ids: ['ParamEyeLOpen', 'PARAM_EYE_L_OPEN'], keys: [[0, 0], [0.45, -0.96], [2.3, -0.96], [2.7, 0]] },
				{ ids: ['ParamEyeROpen', 'PARAM_EYE_R_OPEN'], keys: [[0, 0], [0.45, -0.96], [2.3, -0.96], [2.7, 0]] },
				{ ids: ['ParamAngleY', 'PARAM_ANGLE_Y'], keys: [[0, 0], [0.55, -0.16], [2.3, -0.16], [2.75, 0]] },
				{ ids: ['ParamBodyAngleY', 'PARAM_BODY_ANGLE_Y'], keys: [[0, 0], [0.6, -0.12], [2.35, -0.12], [2.8, 0]] },
			],
		},
		{
			id: 'ears',
			parts: [
				{ ids: ['ParamFoxearL', 'ParamEarL'], keys: [[0, 0], [0.16, -0.45], [0.28, 0.2], [0.4, -0.4], [0.55, 0.15], [0.8, 0]] },
				{ ids: ['ParamFoxearR', 'ParamEarR'], keys: [[0, 0], [0.5, 0], [0.66, 0.2], [0.78, -0.22], [1.0, 0]] },
				{ ids: ['ParamTail', 'PARAM_TAIL'], keys: [[0, 0], [0.25, 0.4], [0.5, -0.3], [0.75, 0.35], [1.05, 0]] },
			],
		},
	];
	/** Basename filter for motions parked in the unnamed group. */
	var LOOSE_KEEP_RE = /touch_|main_|head_dian|head_yao|mtn_shake|ear_doudong|ear_xingfen|ear_shandong|tail_doudong|tail_xingfen/;
	/** One-shot window for a loose clip. Shorter than this is a pose pop; longer is a scene. */
	var LOOSE_MIN_SEC = 0.4;
	var LOOSE_MAX_SEC = 8;
	/** Clicks may play a full character reaction (wedding, login) once, then stop. */
	var CLICK_MAX_SEC = 16;
	/** Unnamed-group files worth a click. Named groups (TapBody, …) are all eligible. */
	var CLICK_FILE_RE = /touch_|main_|head_dian|head_yao|head_diantou|mtn_|ear_doudong|ear_xingfen|ear_shandong|tail_doudong|tail_xingfen|login|mail|mission|wedding|complete|home|effect|gold|oil|diamond/;
	/** Bumped whenever a motion actually starts, so a late fetch cannot overwrite a newer one. */
	var motionGen = 0;

	var state = null;
	var app = null;
	var layer = null;
	var slots = [];
	/** model url -> { model, load: Promise } */
	var modelCache = new Map();
	var vendorPromise = null;
	var chatterTimer = 0;
	var chatterSeq = 0;
	var fidgetTimer = 0;
	var dozeTimer = 0;
	var tossRaf = 0;
	/** Last poke, drag, task reaction, or spoken line. Dozing waits on this. */
	var lastPlayAt = 0;
	var lastReactAt = 0;
	var narrowMedia = null;
	var resizeObs = null;
	var destroyed = false;
	/** Below this width the composer has no side room; mascots step aside. */
	var NARROW_QUERY = '(max-width: 720px)';
	var noticeTimer = 0;
	var stagePointer = null;
	var greetKey = '';
	var dazedIdle = false;
	var yawnedIdle = false;
	var typeGagAt = 0;
	var lastPass = { slot: null, at: 0 };
	var lastWoken = [];
	var YAWN_AFTER_MS = 42 * 1000;
	var DAZE_AFTER_MS = 25 * 1000;

	function pick(list) {
		return list[Math.floor(Math.random() * list.length)];
	}

	function loadScript(src) {
		return new Promise(function (resolve, reject) {
			var el = document.createElement('script');
			el.src = src;
			el.onload = function () { resolve(); };
			el.onerror = function () { reject(new Error('脚本加载失败 ' + src)); };
			document.head.appendChild(el);
		});
	}

	/** pixi-live2d-display 的 cubism4 构建把导出挂在 PIXI.live2d 命名空间
	 * (Live2DModel、SoundManager 等),Application 等 pixi 本体在 PIXI 顶层。 */
	function runtimeReady() {
		return !!(window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel && window.Live2DCubismCore);
	}

	/** Loads pixi (+ no-eval shim) → Cubism core → live2d display, once. */
	function ensureRuntime(vendor) {
		if (runtimeReady()) {
			return Promise.resolve();
		}
		if (!vendorPromise) {
			vendorPromise = loadScript(vendor.pixi)
				// Webview CSP has no 'unsafe-eval'; this shim patches shader
				// uniform sync on load so PIXI.Application can be created.
				.then(function () { return loadScript(vendor.unsafeEval); })
				.then(function () { return loadScript(vendor.core); })
				.then(function () { return loadScript(vendor.l2d); })
				.then(function () {
					if (!runtimeReady()) {
						throw new Error('Live2D 运行时不可用');
					}
					patchSettingsResolveURL();
					// Models stay silent; the export only exists in some builds.
					var sound = window.PIXI.live2d.SoundManager;
					if (sound && 'volume' in sound) {
						sound.volume = 0;
					}
				});
		}
		return vendorPromise;
	}

	/** 库内置的 resolveURL 走 Node 风格 url.resolve,它会把 webview 资源域名
	 * file%2B.vscode-resource.vscode-cdn.net 重新序列化成 https://file/%2B...,
	 * 导致 moc3/贴图/动作全部被 CSP 拦截。换成纯字符串拼接,主机名原样保留。 */
	function patchSettingsResolveURL() {
		var Ctor = window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Cubism4ModelSettings;
		if (!Ctor || !Ctor.prototype || Ctor.prototype.__zcodePlainResolve) {
			return;
		}
		Ctor.prototype.__zcodePlainResolve = true;
		Ctor.prototype.resolveURL = function (relative) {
			var base = String(this.url || '');
			var dirEnd = base.lastIndexOf('/');
			if (dirEnd < 0) {
				return String(relative);
			}
			var dir = base.slice(0, dirEnd + 1);
			var stack = (dir.slice(0, -1)).split('/');
			var parts = String(relative).split('/');
			for (var i = 0; i < parts.length; i++) {
				var seg = parts[i];
				if (seg === '' || seg === '.') {
					continue;
				}
				if (seg === '..') {
					stack.pop();
					continue;
				}
				stack.push(seg);
			}
			return stack.join('/');
		};
	}

	function loadModel(url) {
		var entry = modelCache.get(url);
		if (!entry) {
			patchSettingsResolveURL();
			// autoInteract would also track the pointer, but only events that hit
			// the canvas. The canvas is click-through; the slot proxy drives gaze.
			entry = { model: null, load: window.PIXI.live2d.Live2DModel.from(url, { autoInteract: false, autoUpdate: false }).then(function (model) {
				entry.model = model;
				return model;
			}) };
			modelCache.set(url, entry);
		}
		return entry.load;
	}

	/** Surfaces mascot failures on the page: a console.warn alone is invisible
	 * without webview devtools, which this build does not expose by default. */
	function notify(text) {
		var el = document.getElementById('mascotNotice');
		if (!el) {
			el = document.createElement('div');
			el.id = 'mascotNotice';
			el.className = 'mascot-notice';
			document.body.appendChild(el);
		}
		el.textContent = '精灵：' + text;
		el.classList.add('show');
		window.clearTimeout(noticeTimer);
		noticeTimer = window.setTimeout(function () {
			el.classList.remove('show');
		}, 9000);
	}

	function clearNotice() {
		window.clearTimeout(noticeTimer);
		var el = document.getElementById('mascotNotice');
		if (el) {
			el.classList.remove('show');
		}
	}

	function apply(next) {
		state = next || null;
		void sync();
	}

	function sync() {
		var wanted = state && state.enabled
			? (state.slots || []).filter(function (s) { return s && s.model; })
			: [];
		if (!wanted.length) {
			teardown();
			return;
		}
		destroyed = false;
		var vendor = state.vendor;
		if (!vendor || !vendor.pixi || !vendor.unsafeEval || !vendor.core || !vendor.l2d) {
			notify('脚本地址缺失，请重载窗口后再试');
			return;
		}
		ensureRuntime(vendor).then(function () {
			if (destroyed || !state || !state.enabled) {
				return;
			}
			mountLayer();
			clearNotice();
			// Re-read slots: the selection may have changed while the runtime loaded.
			return syncModels((state.slots || []).filter(function (s) { return s && s.model; }));
		}).catch(function (error) {
			console.warn('[mascot] init failed:', error);
			notify((error && error.message) || String(error));
		});
	}

	function mountLayer() {
		if (app && layer && document.body.contains(layer)) {
			return;
		}
		layer = document.createElement('div');
		layer.className = 'mascot-layer';
		layer.id = 'mascotLayer';
		// Full-viewport layer: dragged mascots may live anywhere on the page.
		layer.style.left = '0';
		layer.style.top = '0';
		layer.style.right = 'auto';
		layer.style.bottom = 'auto';
		layer.style.width = '100%';
		layer.style.height = '100%';
		document.body.appendChild(layer);
		app = new window.PIXI.Application({
			backgroundAlpha: 0,
			antialias: true,
			autoDensity: true,
			resolution: Math.min(2, window.devicePixelRatio || 1),
			powerPreference: 'low-power',
		});
		app.ticker.maxFPS = 30;
		var failureStreaks = []; // [{ node, count }]
		var lastLoopWarnAt = 0;
		function labelForNode(node) {
			for (var j = 0; j < slots.length; j++) {
				var model = slots[j] && slots[j].model;
				if (!model || !node) { continue; }
				if (model === node) { return slots[j].label || slots[j].id || '某个模型'; }
				for (var p = model.parent; p; p = p.parent) {
					if (p === node) { return slots[j].label || slots[j].id || '某个模型'; }
				}
			}
			return '某个模型';
		}
		function stageRootOf(node) {
			var root = node;
			while (root && root.parent && root.parent !== app.stage) {
				root = root.parent;
			}
			return root && root.parent === app.stage ? root : null;
		}
		function quarantineModel(node, phase, error) {
			var rec = null;
			for (var i = 0; i < failureStreaks.length; i++) {
				if (failureStreaks[i].node === node) { rec = failureStreaks[i]; break; }
			}
			if (!rec) {
				rec = { node: node, count: 0 };
				failureStreaks.push(rec);
			}
			rec.count++;
			if (rec.count === 1) {
				var label = labelForNode(node);
				console.warn('[mascot] ' + label + phase + '异常:', error);
				notify(label + ' 的模型数据有问题，已自动停用它（其他精灵不受影响）');
			}
			// 连续多帧失败说明不是偶发：把它从舞台上摘掉，避免拖累渲染。
			if (rec.count >= 5) {
				var root = stageRootOf(node);
				if (root) { app.stage.removeChild(root); }
			}
		}
		function clearFailureStreak(node) {
			for (var i = 0; i < failureStreaks.length; i++) {
				if (failureStreaks[i].node === node) { failureStreaks.splice(i, 1); return; }
			}
		}
		// Models are created with autoUpdate:false and ticked here, one by
		// one. A game-ripped model can throw inside its update (bad motion /
		// physics / drawable data). Here a broken model only skips its own
		// frame, and once it keeps failing it is taken off the stage so the
		// rest stay alive.
		app.ticker.add(function () {
			var dt = app.ticker.deltaMS;
			for (var i = 0; i < slots.length; i++) {
				var model = slots[i] && slots[i].model;
				// Live2DModel 没有 stage 属性（此前用 !model.stage 做守卫，
				// 导致 update 从未被调用、deltaTime 恒为 0，全员冻结）。
				// 只要模型加载完成就累加时间；真正推进动作的是 _render 里
				// 的 internalModel.update(deltaTime)。
				if (!model || !model.internalModel) { continue; }
				try {
					model.update(dt);
					clearFailureStreak(model);
				} catch (e) {
					quarantineModel(model, '动画更新', e);
				}
			}
		});
		// Ticker 兜底：PIXI 的 rAF 回调里任何 listener 抛错（包括
		// Application 内置的 render，坏模型的绘制就会炸）都不会再补排下一
		// 帧，整条动画链直接死掉——这是“加了新精灵后旧的全体冻结”的根因。
		// 把 ticker.update 包一层让循环永不中断，再逐个孩子单独画一次定位
		// 元凶并摘下台；clear:false 只画不清屏，出错帧本就不完整，无副作用。
		var tickerUpdate = app.ticker.update.bind(app.ticker);
		app.ticker.update = function (currentTime) {
			try {
				tickerUpdate(currentTime);
				return;
			} catch (e) {
				if (Date.now() - lastLoopWarnAt > 5000) {
					lastLoopWarnAt = Date.now();
					console.warn('[mascot] 动画循环异常:', e);
				}
			}
			var children = app.stage ? app.stage.children.slice() : [];
			var failures = 0;
			var culprit = null;
			var culpritError = null;
			for (var i = children.length - 1; i >= 0; i--) {
				try {
					app.renderer.render(children[i], { clear: false });
				} catch (e2) {
					failures++;
					if (!culprit) {
						culprit = children[i];
						culpritError = e2;
					}
				}
			}
			// 全员都炸说明是渲染器/上下文的问题，不摘任何模型。
			if (culprit && failures < children.length) {
				var root = stageRootOf(culprit);
				if (root) { app.stage.removeChild(root); }
				quarantineModel(culprit, '渲染', culpritError);
			}
		};
		layer.appendChild(app.view);
		narrowMedia = window.matchMedia(NARROW_QUERY);
		if (typeof narrowMedia.addEventListener === 'function') {
			narrowMedia.addEventListener('change', onNarrowChange);
		}
		document.addEventListener('visibilitychange', onVisibilityChange);
		resizeObs = new ResizeObserver(scheduleLayout);
		resizeObs.observe(document.body);
		window.addEventListener('resize', scheduleLayout);
		window.addEventListener('pointermove', onStagePointer, { passive: true });
		document.addEventListener('input', onComposerInput, true);
		scheduleChatter();
		scheduleFidget();
		lastPlayAt = Date.now();
		scheduleDoze();
		onNarrowChange();
	}

	function teardown() {
		destroyed = true;
		clearTimeout(chatterTimer);
		chatterTimer = 0;
		clearTimeout(fidgetTimer);
		fidgetTimer = 0;
		clearTimeout(dozeTimer);
		dozeTimer = 0;
		if (tossRaf) {
			cancelAnimationFrame(tossRaf);
			tossRaf = 0;
		}
		lastReactAt = 0;
		if (resizeObs) {
			resizeObs.disconnect();
			resizeObs = null;
		}
		window.removeEventListener('resize', scheduleLayout);
		window.removeEventListener('pointermove', onStagePointer);
		document.removeEventListener('input', onComposerInput, true);
		document.removeEventListener('visibilitychange', onVisibilityChange);
		greetKey = '';
		stagePointer = null;
		typeGagAt = 0;
		lastPass = { slot: null, at: 0 };
		lastWoken = [];
		dazedIdle = false;
		yawnedIdle = false;
		if (narrowMedia && typeof narrowMedia.removeEventListener === 'function') {
			narrowMedia.removeEventListener('change', onNarrowChange);
		}
		narrowMedia = null;
		slots.forEach(disownSlot);
		slots = [];
		// The app destroy below tears down stage children (the live models);
		// detached-but-cached models are destroyed here so a later re-enable
		// never resurrects instances bound to the destroyed renderer.
		modelCache.forEach(function (entry) {
			if (entry.model) {
				try { entry.model.destroy(); } catch (e) { /* already gone */ }
			}
		});
		modelCache.clear();
		if (app) {
			try { app.destroy(true, { children: true }); } catch (e) { /* ignore */ }
			app = null;
		}
		if (layer && layer.parentNode) {
			layer.parentNode.removeChild(layer);
		}
		layer = null;
	}

	function disownSlot(slot) {
		endPet(slot, false);
		slot.tossing = false;
		slot.dozing = false;
		if (slot.dozePulse) {
			window.clearInterval(slot.dozePulse);
			slot.dozePulse = 0;
		}
		if (slot.dizzyPulse) {
			window.clearInterval(slot.dizzyPulse);
			slot.dizzyPulse = 0;
		}
		if (slot.stareTimer) {
			window.clearTimeout(slot.stareTimer);
			slot.stareTimer = 0;
		}
		if (slot.petMelt) {
			window.clearTimeout(slot.petMelt);
			slot.petMelt = 0;
		}
		if (slot.wheelGagTimer) {
			window.clearTimeout(slot.wheelGagTimer);
			slot.wheelGagTimer = 0;
		}
		if (slot.flinchRaf) { cancelAnimationFrame(slot.flinchRaf); slot.flinchRaf = 0; }
		if (slot.model) { slot.model.rotation = 0; }
		lookHome(slot);
		if (!slot.el) { return; }
		slot.el.remove();
		slot.el = null;
	}

	/** Takes a slot's model off the pixi stage without destroying it — the
	 * model instance stays in the cache so switching back is instant.
	 * Without this the old model kept animating on the stage forever. */
	function detachModel(slot) {
		var model = slot.model;
		slot.model = null;
		if (model && app && model.parent === app.stage) {
			app.stage.removeChild(model);
		}
	}

	/** Adds/removes proxies so the DOM matches the wanted slots, then reloads. */
	function syncModels(wanted) {
		// Reuse DOM proxies in place; add/remove at the end.
		while (slots.length > wanted.length) {
			var dropped = slots.pop();
			detachModel(dropped);
			disownSlot(dropped);
		}
		var loads = [];
		var slotHeight = currentSizePx();
		for (var i = 0; i < wanted.length; i++) {
			var spec = wanted[i];
			var slot = slots[i];
			if (!slot) {
				slot = { url: '', id: '', model: null, el: null, bubble: 0, height: 0, custom: null, dragging: false };
				slots.push(slot);
			}
			// Per-character height: wheel-resized models carry their own size,
			// everyone else uses the global slider value.
			var wantH = (typeof spec.size === 'number' && isFinite(spec.size) && spec.size > 0)
				? Math.round(spec.size)
				: slotHeight;
			// Size setting changed: resize existing proxies and models in place.
			if (slot.height !== wantH) {
				slot.height = wantH;
				if (slot.el) {
					slot.el.style.height = wantH + 'px';
					slot.el.style.width = Math.round(wantH * 0.78) + 'px';
				}
				if (slot.model) {
					fitModel(slot.model, wantH);
				}
			}
			// Hand-dragged position from the host state (null = default queue).
			slot.custom = spec.pos ? { x: spec.pos.x, y: spec.pos.y } : null;
			slot.persona = spec.persona || '';
			if (spec.label) { slot.label = spec.label; }
			if (slot.url !== spec.model) {
				// Retire the previous model before swapping in the new one.
				detachModel(slot);
				slot.url = spec.model;
				slot.id = spec.id || '';
				slot.label = spec.label || '';
				if (!slot.el) {
					slot.el = document.createElement('div');
					slot.el.className = 'mascot-slot';
					layer.appendChild(slot.el);
					// Listeners are bound once per element; re-binding on every
					// switch stacked duplicates (one tap fired N bubbles).
					bindSlot(slot);
				}
				slot.el.textContent = '';
				slot.el.style.height = slot.height + 'px';
				slot.el.style.width = Math.round(slot.height * 0.78) + 'px';
				loads.push(attachModel(slot, slotHeight));
			}
		}
		scheduleLayout();
		return Promise.all(loads);
	}

	/** Slider height in CSS px, clamped; falls back for old preset configs. */
	function currentSizePx() {
		var px = Number(state && state.sizePx);
		if (!px || !isFinite(px)) {
			px = DEFAULT_SIZE_PX;
		}
		return Math.max(SIZE_MIN_PX, Math.min(SIZE_MAX_PX, Math.round(px)));
	}

	/**
	 * Stops the model's looping Idle motion — the constant up-and-down body
	 * bob the sample models ship with. Eye blink, the subtle breathing sway
	 * and tap-triggered motions are untouched; only the auto-looping idle
	 * track is silenced.
	 */
	function disableIdleMotion(model) {
		try {
			var manager = model && model.internalModel && model.internalModel.motionManager;
			if (!manager) { return; }
			if (manager.groups) { manager.groups.idle = null; }
			if (typeof manager.stopAllMotions === 'function') { manager.stopAllMotions(); }
		} catch (e) { /* keep default behaviour */ }
	}

	/** Scales a model so it stands exactly `height` CSS pixels tall. */
	function fitModel(model, height) {
		model.anchor.set(0.5, 1);
		model.scale.set(1);
		model.scale.set(height / Math.max(1, model.height));
		model.__zcodeHeight = height;
		disableIdleMotion(model);
	}

	function attachModel(slot, height) {
		var url = slot.url;
		return loadModel(url).then(function (model) {
			if (destroyed || slot.url !== url) {
				return;
			}
			slot.model = model;
			if (!app) { return; }
			if (model.parent !== app.stage) {
				app.stage.addChild(model);
			}
			fitModel(model, slot.height || height);
			scheduleLayout();
			maybeGreet();
		}).catch(function (error) {
			console.warn('[mascot] model failed:', url, error);
			notify('模型加载失败：' + String((error && error.message) || error).slice(0, 120));
		});
	}

	function bindSlot(slot) {
		var el = slot.el;
		el.__zcodeMascot = slot;
		el.addEventListener('pointerdown', function (event) {
			if (event.button !== 0) { return; }
			startDrag(slot, event);
		});
		el.addEventListener('wheel', function (event) {
			// Wheel over the character = per-model size. Models differ a lot in
			// native size, so each remembers its own height, not the slider's.
			event.preventDefault();
			event.stopPropagation();
			var step = event.deltaY > 0 ? -16 : 16;
			if (event.ctrlKey) { step = step / 4; }
			var next = Math.max(SIZE_MIN_PX, Math.min(SIZE_MAX_PX, slot.height + step));
			if (next === slot.height) { return; }
			slot.height = next;
			el.style.height = next + 'px';
			el.style.width = Math.round(next * 0.78) + 'px';
			if (slot.model) { fitModel(slot.model, next); }
			scheduleLayout();
			if (slot.wheelGagTimer) {
				window.clearTimeout(slot.wheelGagTimer);
			} else {
				playGag(slot, step > 0 ? 'grow' : 'shrink');
			}
			slot.wheelGagTimer = window.setTimeout(function () { slot.wheelGagTimer = 0; }, 700);
			if (slot.wheelTimer) { clearTimeout(slot.wheelTimer); }
			slot.wheelTimer = setTimeout(function () {
				var cb = window.ZCodeMascots && window.ZCodeMascots.onSize;
				if (typeof cb === 'function') { cb(slot.id, next); }
			}, 300);
		}, { passive: false });
		el.addEventListener('contextmenu', function (event) {
			event.preventDefault();
			resetSlot(slot);
		});
		el.addEventListener('pointermove', function (event) {
			if (slot.dragging) { return; }
			lookAt(slot, event.clientX, event.clientY);
			if (slot.stared) { return; }
			var drifted = slot.stareX != null
				&& Math.abs(event.clientX - slot.stareX) + Math.abs(event.clientY - slot.stareY) > 18;
			if (slot.stareTimer && !drifted) { return; }
			if (slot.stareTimer) {
				window.clearTimeout(slot.stareTimer);
				slot.stareTimer = 0;
			}
			slot.stareX = event.clientX;
			slot.stareY = event.clientY;
			slot.stareTimer = window.setTimeout(function () {
				slot.stareTimer = 0;
				if (slot.dragging || slot.tossing || !slot.el) { return; }
				slot.stared = true;
				notePlay(slot, { quiet: true });
				playGag(slot, 'stare');
			}, 2200);
		});
		el.addEventListener('pointerleave', function () {
			if (slot.stareTimer) {
				window.clearTimeout(slot.stareTimer);
				slot.stareTimer = 0;
			}
			if (slot.dragging) { return; }
			lookHome(slot);
			if (slot.stared) {
				slot.stared = false;
				notePlay(slot, { quiet: true });
				playGag(slot, 'leave');
			}
		});
	}

	/** Head and eyes ease toward the pointer. The library adds this on top of
	 *  the current pose each frame, and a target of (0, 0) settles back. */
	function lookAt(slot, clientX, clientY) {
		var model = slot.model;
		var fc = model && model.internalModel && model.internalModel.focusController;
		if (!fc || !slot.el || typeof fc.focus !== 'function') { return; }
		var rect = slot.el.getBoundingClientRect();
		var faceX = rect.left + rect.width * 0.5;
		var faceY = rect.top + rect.height * 0.3;
		var nx = (clientX - faceX) / Math.max(1, rect.width * 0.65);
		var ny = (clientY - faceY) / Math.max(1, rect.height * 0.5);
		if (nx > 1) { nx = 1; } else if (nx < -1) { nx = -1; }
		if (ny > 1) { ny = 1; } else if (ny < -1) { ny = -1; }
		fc.focus(nx * 0.8, -ny * 0.65);
	}

	function lookHome(slot) {
		var model = slot && slot.model;
		var fc = model && model.internalModel && model.internalModel.focusController;
		if (fc && typeof fc.focus === 'function') { fc.focus(0, 0); }
	}

	function pointerOverSlot(slot, event) {
		if (!slot.el || !event) { return false; }
		var rect = slot.el.getBoundingClientRect();
		return event.clientX >= rect.left && event.clientX <= rect.right
			&& event.clientY >= rect.top && event.clientY <= rect.bottom;
	}

	/** Drag-to-place. A press that moves under 5px counts as a tap (motion,
	 *  gift, bubble). Holding still past PET_HOLD_MS pets instead: hearts keep
	 *  rising until release, and that press does not also count as a tap.
	 *  Anything further drags the character and persists the drop point
	 *  through the onMove hook (chatView wires it to the host). Letting go
	 *  while the pointer is still fast throws the character instead. */
	function startDrag(slot, event) {
		if (!slot.el || slot.dragging) { return; }
		if (slot.tossing) {
			commitDropFromElement(slot);
			slot.tossing = false;
			if (slot.model) { slot.model.rotation = 0; }
		}
		var wasDozing = !!slot.dozing;
		notePlay(slot);
		var el = slot.el;
		slot.dragging = true;
		el.classList.add('dragging');
		lookAt(slot, event.clientX, event.clientY);
		var grabX = event.clientX;
		var grabY = event.clientY;
		var baseLeft = el.offsetLeft;
		var baseTop = el.offsetTop;
		var moved = 0;
		var samples = [{ t: event.timeStamp || Date.now(), x: event.clientX, y: event.clientY }];
		var drag = {
			spin: 0, ang: null, dirX: 0, dirY: 0, flipX: 0, flipY: 0, travel: 0,
			crossed: null, px: event.clientX, py: event.clientY,
		};
		var petTimer = window.setTimeout(function () {
			petTimer = 0;
			if (moved >= 5 || !slot.dragging) { return; }
			beginPet(slot, grabX, grabY);
		}, PET_HOLD_MS);
		try { el.setPointerCapture(event.pointerId); } catch (e) { /* older hosts */ }
		function onMoveFn(ev) {
			var dx = ev.clientX - grabX;
			var dy = ev.clientY - grabY;
			moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
			slot.petX = ev.clientX;
			slot.petY = ev.clientY;
			lookAt(slot, ev.clientX, ev.clientY);
			samples.push({ t: ev.timeStamp || Date.now(), x: ev.clientX, y: ev.clientY });
			if (samples.length > 6) { samples.shift(); }
			if (moved < 5) { return; }
			if (petTimer) { window.clearTimeout(petTimer); petTimer = 0; }
			if (slot.petting) { endPet(slot, true); }
			trackDrag(slot, drag, ev.clientX, ev.clientY);
			el.style.left = (baseLeft + dx) + 'px';
			el.style.top = (baseTop + dy) + 'px';
			var liveBubble = el.querySelector('.mascot-bubble.show');
			if (liveBubble) { placeBubble(liveBubble); }
			if (slot.model) {
				slot.model.x = baseLeft + dx + el.offsetWidth / 2;
				slot.model.y = baseTop + dy + el.offsetHeight;
			}
		}
		function onUpFn(ev) {
			el.removeEventListener('pointermove', onMoveFn);
			el.removeEventListener('pointerup', onUpFn);
			el.removeEventListener('pointercancel', onUpFn);
			if (petTimer) { window.clearTimeout(petTimer); petTimer = 0; }
			var wasPetting = !!slot.petting;
			endPet(slot, true);
			slot.dragging = false;
			el.classList.remove('dragging');
			if (!pointerOverSlot(slot, ev)) { lookHome(slot); }
			if (wasPetting) { speakWoken(slot); return; }
			if (moved < 5) {
				onTap(slot, ev, wasDozing);
				return;
			}
			var dx = ev.clientX - grabX;
			var dy = ev.clientY - grabY;
			el.style.left = (baseLeft + dx) + 'px';
			el.style.top = (baseTop + dy) + 'px';
			if (slot.model) {
				slot.model.x = baseLeft + dx + el.offsetWidth / 2;
				slot.model.y = baseTop + dy + el.offsetHeight;
			}
			speakWoken(slot);
			var vel = releaseVelocity(samples, ev);
			var speed = Math.abs(vel.x) + Math.abs(vel.y);
			if (speed >= TOSS_SPEED && sparksAllowed()) {
				if (dizzyActive(slot)) {
					commitDropFromElement(slot);
					playGag(slot, 'stillDizzy');
					return;
				}
				beginToss(slot, vel);
				return;
			}
			settleDrop(slot, drag);
		}
		el.addEventListener('pointermove', onMoveFn);
		el.addEventListener('pointerup', onUpFn);
		el.addEventListener('pointercancel', onUpFn);
	}

	/** Press-and-hold on the character: one smile, then a heart every beat. */
	function beginPet(slot, clientX, clientY) {
		if (!slot.model || slot.petting) { return; }
		slot.petting = true;
		slot.petAt = Date.now();
		slot.petX = clientX;
		slot.petY = clientY;
		if (slot.el) { slot.el.classList.add('petting'); }
		var curing = dizzyActive(slot);
		if (curing) { clearDizzy(slot); }
		if (curing) {
			playGag(slot, 'undizzy');
		} else {
			if (!playNamed(slot, 'smile')) { playNamed(slot, 'ears'); }
			voiceSay(slot, 'pet', personaLine(slot, 'pet', PET_LINES));
		}
		spawnBits(slot, clientX, clientY, { glyphs: HEARTS, count: 4 });
		slot.petPulse = window.setInterval(function () {
			spawnBits(slot, slot.petX, slot.petY, { glyphs: HEARTS, count: 1 });
		}, 180);
		slot.petMelt = window.setTimeout(function () {
			slot.petMelt = 0;
			if (slot.petting) { playGag(slot, 'melt'); }
		}, 2800);
	}

	function endPet(slot, speak) {
		if (!slot) { return; }
		var held = !!(speak && slot.petting && slot.petAt && Date.now() - slot.petAt > 1100);
		slot.petting = false;
		if (slot.petPulse) {
			window.clearInterval(slot.petPulse);
			slot.petPulse = 0;
		}
		if (slot.petMelt) {
			window.clearTimeout(slot.petMelt);
			slot.petMelt = 0;
		}
		if (slot.el) { slot.el.classList.remove('petting'); }
		if (held) { playGag(slot, 'again'); }
	}

	/** Pointer velocity over the last ~50ms, capped so a wild flick still lands. */
	function releaseVelocity(samples, ev) {
		var now = ev.timeStamp || Date.now();
		var recent = samples[0];
		for (var i = samples.length - 1; i >= 0; i--) {
			recent = samples[i];
			if (now - samples[i].t >= 48) { break; }
		}
		if (!recent) { return { x: 0, y: 0 }; }
		var dt = Math.max(16, now - recent.t);
		var vx = (ev.clientX - recent.x) / dt;
		var vy = (ev.clientY - recent.y) / dt;
		var cap = 2.2;
		if (vx > cap) { vx = cap; } else if (vx < -cap) { vx = -cap; }
		if (vy > cap) { vy = cap; } else if (vy < -cap) { vy = -cap; }
		return { x: vx, y: vy };
	}

	/** Remember the slot's current pixel box as its dropped position. The
	 *  bottom may sit past the fold; ~20% of the body stays reachable. */
	function commitDropFromElement(slot) {
		var el = slot.el;
		if (!el) { return; }
		var w = window.innerWidth || document.documentElement.clientWidth || 1;
		var h = window.innerHeight || document.documentElement.clientHeight || 1;
		var sh = el.offsetHeight || 1;
		var bottom = el.offsetTop + el.offsetHeight;
		var x = Math.min(0.98, Math.max(0.02, (el.offsetLeft + el.offsetWidth / 2) / w));
		var y = Math.min(h + sh * 0.8, Math.max(sh * 0.2, bottom)) / h;
		slot.custom = { x: x, y: y };
		var cb = window.ZCodeMascots && window.ZCodeMascots.onMove;
		if (cb) { cb({ id: slot.id, x: x, y: y }); }
	}

	function hushVoice(slot) {
		if (!slot) { return; }
		slot.voiceSeq = ++voiceSeq;
		window.clearTimeout(slot.voiceTimer);
		slot.voiceTimer = 0;
	}

	function flinch(slot) {
		if (!slot.model || !sparksAllowed() || slot.tossing || slot.dragging) { return; }
		var t0 = performance.now();
		if (slot.flinchRaf) { cancelAnimationFrame(slot.flinchRaf); }
		function step(now) {
			slot.flinchRaf = 0;
			if (!slot.model || slot.tossing || slot.dragging || destroyed) {
				if (slot.model && !slot.tossing) { slot.model.rotation = 0; }
				return;
			}
			var k = (now - t0) / 380;
			if (k >= 1) { slot.model.rotation = 0; return; }
			slot.model.rotation = Math.sin(k * Math.PI) * -0.2;
			slot.flinchRaf = window.requestAnimationFrame(step);
		}
		slot.flinchRaf = window.requestAnimationFrame(step);
	}

	function playGag(slot, id) {
		var g = GAGS[id];
		if (!g || !slot || !slot.el || destroyed) { return false; }
		hushVoice(slot);
		slot.gagAt = Date.now();
		slot.gagId = id;
		if (slot.model && g.motion) {
			if (!playNamed(slot, g.motion)) { playNamed(slot, 'tilt'); }
		}
		if (g.flinch) { flinch(slot); }
		var rect = slot.el.getBoundingClientRect();
		spawnBits(slot, rect.left + rect.width / 2, rect.top + rect.height * 0.22, {
			glyphs: g.glyphs || ['✨'],
			count: g.count || 4,
		});
		if (g.lines && g.lines.length) { say(slot, pick(g.lines)); }
		return true;
	}

	function playPair(slot, rel) {
		var g = rel && GAGS[rel.kind];
		var other = rel && rel.other;
		if (!g || !slot || !slot.el) { return; }
		if (!other || !other.el) { playGag(slot, rel.kind); return; }
		hushVoice(slot);
		hushVoice(other);
		if (slot.model && g.motion) {
			if (!playNamed(slot, g.motion)) { playNamed(slot, 'tilt'); }
		}
		if (other.model) {
			if (!playNamed(other, g.motion || 'smile')) { playNamed(other, 'tilt'); }
		}
		var mine = slot.el.getBoundingClientRect();
		var rect = other.el.getBoundingClientRect();
		lookAt(slot, rect.left + rect.width / 2, rect.top + rect.height * 0.28);
		lookAt(other, mine.left + mine.width / 2, mine.top + mine.height * 0.28);
		window.setTimeout(function () {
			if (!slot.dragging) { lookHome(slot); }
			if (!other.dragging) { lookHome(other); }
		}, 1600);
		var cx = (Math.max(mine.left, rect.left) + Math.min(mine.right, rect.right)) / 2;
		var cy = (Math.max(mine.top, rect.top) + Math.min(mine.bottom, rect.bottom)) / 2;
		if (!(cx > 0)) {
			cx = (mine.left + mine.right + rect.left + rect.right) / 4;
			cy = (mine.top + rect.top) / 2;
		}
		spawnBits(slot, cx, cy, { glyphs: g.glyphs || HEARTS, count: g.count || 5 });
		var first = slot;
		var second = other;
		var firstLines = g.lines;
		var secondLines = g.replies;
		if (g.catcherFirst) {
			first = other;
			second = slot;
		}
		if (rel.kind === 'taller') {
			var slotTaller = slot.el.offsetHeight >= other.el.offsetHeight;
			first = slotTaller ? slot : other;
			second = slotTaller ? other : slot;
			firstLines = ['我高一点', '上面风景好', '你要垫脚吗'];
			secondLines = ['那我看腿长', '身高不是全部', '哼'];
		}
		if (firstLines && firstLines.length && first.el) { say(first, pick(firstLines)); }
		if (secondLines && secondLines.length) {
			window.setTimeout(function () {
				if (second.el) { say(second, pick(secondLines)); }
			}, 640);
		}
	}

	function headBand(r) {
		var h = r.height * 0.32;
		return { left: r.left, right: r.right, top: r.top, bottom: r.top + h, width: r.width, height: h };
	}

	function gapX(a, b) {
		if (a.right < b.left) { return b.left - a.right; }
		if (b.right < a.left) { return a.left - b.right; }
		return -1;
	}

	function verticalFrac(a, b) {
		var ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
		if (ih <= 0) { return 0; }
		return ih / Math.max(1, Math.min(a.height, b.height));
	}

	function isStack(mine, other) {
		var iw = Math.min(mine.right, other.right) - Math.max(mine.left, other.left);
		if (iw < Math.min(mine.width, other.width) * 0.34) { return false; }
		var myMid = (mine.top + mine.bottom) / 2;
		var oMid = (other.top + other.bottom) / 2;
		if (myMid > oMid - other.height * 0.05) { return false; }
		return mine.bottom < other.top + other.height * 0.48 && mine.bottom > other.top - other.height * 0.15;
	}

	function relation(mine, rect) {
		if (isStack(mine, rect)) { return 'stack'; }
		var overlap = overlapRatio(mine, rect);
		var mx = (mine.left + mine.right) / 2;
		var my = (mine.top + mine.bottom) / 2;
		var ox = (rect.left + rect.right) / 2;
		var oy = (rect.top + rect.bottom) / 2;
		var cdist = Math.hypot(mx - ox, my - oy);
		if (cdist < 36 && overlap > 0.18) { return 'steal'; }
		if (overlap >= 0.48) { return 'hug'; }
		var heads = overlapRatio(headBand(mine), headBand(rect));
		if (heads > 0.12 && overlap < 0.3) { return 'five'; }
		if (overlap >= 0.22) { return 'nuzzle'; }
		var gx = gapX(mine, rect);
		var vfrac = verticalFrac(mine, rect);
		if (gx >= -8 && gx <= 36 && vfrac > 0.38) {
			if (Math.abs(mine.bottom - rect.bottom) < 42 && Math.abs(mine.height - rect.height) > 52) { return 'taller'; }
			return 'hand';
		}
		if (gx > 36 && gx < 120 && vfrac > 0.28) { return 'gaze'; }
		return '';
	}

	function squeezeOf(slot, mine) {
		var left = null;
		var right = null;
		var mid = (mine.left + mine.right) / 2;
		var my = (mine.top + mine.bottom) / 2;
		for (var i = 0; i < slots.length; i++) {
			var other = slots[i];
			if (other === slot || !other.el || !other.model || other.tossing) { continue; }
			var r = other.el.getBoundingClientRect();
			var ox = (r.left + r.right) / 2;
			var oy = (r.top + r.bottom) / 2;
			if (Math.abs(oy - my) > mine.height * 0.45) { continue; }
			var dist = Math.abs(ox - mid);
			if (dist > mine.width * 1.35 || dist < 8) { continue; }
			if (ox < mid) {
				if (!left || dist < left.d) { left = { other: other, d: dist }; }
			} else if (!right || dist < right.d) {
				right = { other: other, d: dist };
			}
		}
		if (left && right) { return { kind: 'squeeze', other: left.other }; }
		return null;
	}

	function companyOf(slot) {
		if (!slot.el) { return null; }
		var mine = slot.el.getBoundingClientRect();
		var near = [];
		for (var i = 0; i < slots.length; i++) {
			var other = slots[i];
			if (other === slot || !other.el || !other.model || other.tossing) { continue; }
			var rect = other.el.getBoundingClientRect();
			if (Math.abs(rect.bottom - mine.bottom) < 56 && gapX(mine, rect) < 120) { near.push(other); }
		}
		if (near.length >= 2) {
			var xs = [(mine.left + mine.right) / 2];
			for (var n = 0; n < near.length; n++) {
				var rr = near[n].el.getBoundingClientRect();
				xs.push((rr.left + rr.right) / 2);
			}
			xs.sort(function (a, b) { return a - b; });
			if (xs[xs.length - 1] - xs[0] > mine.width * 0.8) {
				return { kind: 'queue', other: near[0] };
			}
		}
		var squeezed = squeezeOf(slot, mine);
		if (squeezed) { return squeezed; }
		var best = null;
		var bestD = 1e9;
		for (var j = 0; j < slots.length; j++) {
			var o = slots[j];
			if (o === slot || !o.el || !o.model || o.tossing) { continue; }
			var r = o.el.getBoundingClientRect();
			var kind = relation(mine, r);
			if (!kind) { continue; }
			var dx = (mine.left + mine.right) / 2 - (r.left + r.right) / 2;
			var dy = (mine.top + mine.bottom) / 2 - (r.top + r.bottom) / 2;
			var d = dx * dx + dy * dy;
			if (d < bestD) { bestD = d; best = { kind: kind, other: o }; }
		}
		return best;
	}

	function pairBlocked(a, b) {
		if (!b) { return false; }
		var now = Date.now();
		if (now - (a.pairAt || 0) < 2200 || now - (b.pairAt || 0) < 2200) { return true; }
		a.pairAt = now;
		b.pairAt = now;
		return false;
	}

	function reactToCompany(slot, via) {
		var rel = companyOf(slot);
		if (!rel) { return false; }
		if (rel.other && pairBlocked(slot, rel.other)) { return true; }
		if (via === 'land' && (rel.kind === 'nuzzle' || rel.kind === 'hug' || rel.kind === 'steal' || rel.kind === 'five')) {
			rel = { kind: 'bump', other: rel.other };
		}
		playPair(slot, rel);
		return true;
	}

	function composerRect() {
		var c = document.getElementById('composer');
		if (!c || !c.isConnected) { return null; }
		return c.getBoundingClientRect();
	}

	function placeKind(slot) {
		var rect = slot.el.getBoundingClientRect();
		var viewW = window.innerWidth || document.documentElement.clientWidth || 1;
		var viewH = window.innerHeight || document.documentElement.clientHeight || 1;
		var nearL = rect.left < 36;
		var nearR = rect.right > viewW - 36;
		var nearT = rect.top < 36;
		var nearB = rect.bottom > viewH - 28;
		if ((nearL || nearR) && (nearT || nearB)) { return 'corner'; }
		if (nearL || nearR) { return 'wallHug'; }
		var comp = composerRect();
		if (comp) {
			var iw = Math.min(rect.right, comp.right) - Math.max(rect.left, comp.left);
			var ih = Math.min(rect.bottom, comp.bottom) - Math.max(rect.top, comp.top);
			var overlap = iw > 0 && ih > 0 ? (iw * ih) / Math.max(1, rect.width * rect.height) : 0;
			var peek = rect.bottom >= comp.top - 8 && rect.bottom <= comp.top + 52 && iw > rect.width * 0.3 && rect.top < comp.top;
			if (peek && overlap < 0.35) { return 'peek'; }
			if (overlap > 0.22) { return 'desk'; }
		}
		if (rect.top < viewH * 0.16) { return 'high'; }
		if (rect.bottom > viewH * 0.86) { return 'crouch'; }
		return 'place';
	}

	function rectsOverlap(a, b) {
		return Math.min(a.right, b.right) > Math.max(a.left, b.left)
			&& Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
	}

	function trackDrag(slot, drag, x, y) {
		var dx = x - drag.px;
		var dy = y - drag.py;
		var step = Math.hypot(dx, dy);
		if (step < 4) { return; }
		drag.travel += step;
		var ang = Math.atan2(dy, dx);
		if (drag.ang != null) {
			var turn = ang - drag.ang;
			while (turn > Math.PI) { turn -= Math.PI * 2; }
			while (turn < -Math.PI) { turn += Math.PI * 2; }
			drag.spin += turn;
		}
		drag.ang = ang;
		if (dx > 2 || dx < -2) {
			var sx = dx > 0 ? 1 : -1;
			if (drag.dirX && sx !== drag.dirX) { drag.flipX += 1; }
			drag.dirX = sx;
		}
		if (dy > 2 || dy < -2) {
			var sy = dy > 0 ? 1 : -1;
			if (drag.dirY && sy !== drag.dirY) { drag.flipY += 1; }
			drag.dirY = sy;
		}
		for (var i = 0; i < slots.length; i++) {
			var other = slots[i];
			if (other === slot || !other.el) { continue; }
			var rect = other.el.getBoundingClientRect();
			if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
				drag.crossed = other;
			}
		}
		drag.px = x;
		drag.py = y;
	}

	function settleDrop(slot, drag) {
		commitDropFromElement(slot);
		if (!slot.el) { return; }
		if (drag && Math.abs(drag.spin) > 4.2 && drag.travel > 80) { playGag(slot, 'spin'); return; }
		if (drag && drag.flipX >= 3 && drag.travel > 48) { playGag(slot, 'wiggle'); return; }
		if (drag && drag.flipY >= 3 && drag.travel > 48) { playGag(slot, 'hopdrag'); return; }
		if (drag && drag.crossed && drag.crossed.el && !rectsOverlap(slot.el.getBoundingClientRect(), drag.crossed.el.getBoundingClientRect())) {
			playPair(slot, { kind: 'brush', other: drag.crossed });
			return;
		}
		if (reactToCompany(slot, 'drop')) { return; }
		playGag(slot, placeKind(slot));
	}

	function clearDizzy(slot) {
		if (!slot) { return; }
		slot.dizzyUntil = 0;
		slot.tossWillDizzy = false;
		slot.tossLog = [];
		if (slot.dizzyPulse) {
			window.clearInterval(slot.dizzyPulse);
			slot.dizzyPulse = 0;
		}
	}

	function dizzyActive(slot) {
		if (slot.dizzyUntil && Date.now() >= slot.dizzyUntil) { clearDizzy(slot); }
		return !!(slot.dizzyUntil && slot.dizzyUntil > Date.now());
	}

	function startDizzy(slot) {
		slot.dizzyUntil = Date.now() + 6500;
		playGag(slot, 'dizzy');
		if (slot.dizzyPulse) { window.clearInterval(slot.dizzyPulse); }
		slot.dizzyPulse = window.setInterval(function () {
			if (!slot.el || Date.now() >= (slot.dizzyUntil || 0)) {
				clearDizzy(slot);
				return;
			}
			var r = slot.el.getBoundingClientRect();
			spawnBits(slot, r.left + r.width * 0.66, r.top + 8, { glyphs: ['💫', '⭐', '🌀'], count: 1 });
		}, 700);
	}

	function countToss(slot) {
		var now = Date.now();
		if (!slot.tossLog) { slot.tossLog = []; }
		slot.tossLog = slot.tossLog.filter(function (t) { return now - t < 14000; });
		slot.tossLog.push(now);
		return slot.tossLog.length >= 3;
	}

	function tossNote(slot, id) {
		if (!id || slot.tossSaid) { return; }
		slot.tossSaid = id;
		playGag(slot, id);
	}

	function catchPair(slot, other) {
		slot.tossing = false;
		slot.tossT = 0;
		slot.tossWillDizzy = false;
		if (slot.model) { slot.model.rotation = 0; }
		var el = slot.el;
		var host = other.el;
		if (!el || !host) { return; }
		var side = slot.tossVX >= 0 ? -1 : 1;
		var left = host.offsetLeft + side * Math.round(el.offsetWidth * 0.62);
		var top = host.offsetTop + Math.round(host.offsetHeight * 0.08);
		el.style.left = left + 'px';
		el.style.top = top + 'px';
		if (slot.model) {
			slot.model.x = left + el.offsetWidth / 2;
			slot.model.y = top + el.offsetHeight;
			slot.model.rotation = 0;
		}
		commitDropFromElement(slot);
		playPair(slot, { kind: 'catch', other: other });
	}

	function tryCatch(slot) {
		var el = slot.el;
		if (!el) { return false; }
		var traveled = Math.hypot(el.offsetLeft - (slot.tossOriginX || 0), el.offsetTop - (slot.tossOriginY || 0));
		if (traveled < 70) { return false; }
		var mine = el.getBoundingClientRect();
		var mx = (mine.left + mine.right) / 2;
		var my = (mine.top + mine.bottom) / 2;
		for (var i = 0; i < slots.length; i++) {
			var other = slots[i];
			if (other === slot || !other.el || !other.model || other.tossing || other.dragging) { continue; }
			var rect = other.el.getBoundingClientRect();
			var ox = (rect.left + rect.right) / 2;
			var oy = (rect.top + rect.bottom) / 2;
			var dx = ox - mx;
			var dy = oy - my;
			var dist = Math.hypot(dx, dy);
			if (dist > (mine.width + rect.width) * 0.32) { continue; }
			if (slot.tossVX * dx + slot.tossVY * dy <= 0) { continue; }
			catchPair(slot, other);
			return true;
		}
		return false;
	}

	function liveSlots() {
		var list = [];
		for (var i = 0; i < slots.length; i++) {
			var slot = slots[i];
			if (slot.model && slot.el && !slot.dragging && !slot.tossing && !slot.petting) { list.push(slot); }
		}
		return list;
	}

	function mascotsHidden() {
		return destroyed || !!(narrowMedia && narrowMedia.matches);
	}

	function greetId(d) {
		var day = d.getDay();
		var h = d.getHours();
		if (h < 5) { return 'midnight'; }
		if (day === 0 || day === 6) { return 'weekend'; }
		if (day === 5) { return 'friday'; }
		if (h < 11) { return 'morning'; }
		if (h < 14) { return 'noon'; }
		if (h < 17) { return 'tea'; }
		if (h < 22) { return 'evening'; }
		return 'night';
	}

	function maybeGreet() {
		if (destroyed || greetKey) { return; }
		var live = liveSlots();
		if (!live.length) { return; }
		var id = greetId(new Date());
		greetKey = id;
		var slot = live[0];
		window.setTimeout(function () {
			if (destroyed || !slot.el || slot.dragging || slot.tossing) { return; }
			notePlay(null, { quiet: true });
			playGag(slot, id);
		}, 800);
	}

	function chimeIfNew() {
		if (!greetKey || mascotsHidden() || document.hidden) { return false; }
		var id = greetId(new Date());
		if (id === greetKey) { return false; }
		var live = liveSlots();
		if (!live.length) { return false; }
		greetKey = id;
		playGag(pick(live), id);
		return true;
	}

	function overHead(slot, ev) {
		if (!slot.el) { return false; }
		var rect = slot.el.getBoundingClientRect();
		return (ev.clientY - rect.top) / Math.max(1, rect.height) < 0.42;
	}

	function onStagePointer(ev) {
		if (mascotsHidden()) { return; }
		var now = ev.timeStamp || Date.now();
		var prev = stagePointer;
		var overSlot = null;
		var dt = prev ? Math.max(8, now - prev.t) : 1000;
		var dist = prev ? Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) : 0;
		var speed = dt < 100 ? dist / dt : 0;
		for (var i = 0; i < slots.length; i++) {
			var slot = slots[i];
			if (!slot.el || slot.dragging || slot.tossing) { continue; }
			var over = pointerOverSlot(slot, ev);
			if (over && !overSlot) { overSlot = slot; }
			if (ev.buttons) { continue; }
			var was = prev && prev.over === slot;
			if (over && was && overHead(slot, ev) && speed > 0.05 && speed < 0.55) {
				slot.blowMs = (slot.blowMs || 0) + dt;
				slot.blowDist = (slot.blowDist || 0) + dist;
				if (slot.blowMs > 680 && slot.blowDist > 28 && now - (slot.blowAt || 0) > 6000) {
					slot.blowAt = now;
					slot.blowMs = 0;
					slot.blowDist = 0;
					if (slot.stareTimer) { window.clearTimeout(slot.stareTimer); slot.stareTimer = 0; }
					notePlay(slot, { quiet: true });
					playGag(slot, 'blow');
				}
			} else if (!over) {
				slot.blowMs = 0;
				slot.blowDist = 0;
			}
		}
		stagePointer = { t: now, x: ev.clientX, y: ev.clientY, over: overSlot };
	}

	function onComposerInput(ev) {
		if (mascotsHidden()) { return; }
		var target = ev.target;
		if (!target || !target.closest || !target.closest('#composer')) { return; }
		notePlay(null, { quiet: true });
		var now = Date.now();
		if (now < typeGagAt) { return; }
		var live = liveSlots();
		if (!live.length) { return; }
		typeGagAt = now + 14000;
		playGag(pick(live), 'typing');
	}

	function speakWoken(except) {
		if (!lastWoken || !lastWoken.length) { return; }
		var list = lastWoken;
		lastWoken = [];
		for (var i = 0; i < list.length; i++) {
			if (list[i] !== except && list[i].el) { playGag(list[i], 'wokenBy'); }
		}
	}

	function beginToss(slot, vel) {
		slot.tossing = true;
		slot.tossVX = vel.x;
		slot.tossVY = vel.y;
		slot.tossBounces = 0;
		slot.tossT = 0;
		slot.tossSaid = '';
		slot.tossWillDizzy = countToss(slot);
		slot.tossOriginX = slot.el.offsetLeft;
		slot.tossOriginY = slot.el.offsetTop;
		if (!playNamed(slot, 'wave')) { playNamed(slot, 'shake'); }
		var rect = slot.el.getBoundingClientRect();
		spawnBits(slot, rect.left + rect.width / 2, rect.top + 24, { glyphs: ['✨', '💫', '⭐'], count: 5 });
		if (!tossRaf) { tossRaf = window.requestAnimationFrame(stepToss); }
	}

	function stepToss(ts) {
		tossRaf = 0;
		var any = false;
		var now = ts || performance.now();
		for (var i = 0; i < slots.length; i++) {
			var slot = slots[i];
			if (!slot.tossing || !slot.el) { continue; }
			any = true;
			var prev = slot.tossT || now;
			var dt = Math.min(34, Math.max(0, now - prev));
			slot.tossT = now;
			slot.tossVY += 0.0017 * dt;
			slot.tossVX *= Math.pow(0.99955, dt);
			var el = slot.el;
			var left = el.offsetLeft + slot.tossVX * dt;
			var top = el.offsetTop + slot.tossVY * dt;
			var viewW = window.innerWidth || document.documentElement.clientWidth;
			var viewH = window.innerHeight || document.documentElement.clientHeight;
			var sw = el.offsetWidth;
			var sh = el.offsetHeight;
			var note = '';
			if (left < 4) {
				var incomingL = Math.abs(slot.tossVX);
				left = 4;
				slot.tossVX = incomingL * 0.55;
				slot.tossBounces += 1;
				note = incomingL > 1.15 ? 'fly' : 'wall';
			} else if (left + sw > viewW - 4) {
				var incomingR = Math.abs(slot.tossVX);
				left = viewW - 4 - sw;
				slot.tossVX = -incomingR * 0.55;
				slot.tossBounces += 1;
				note = incomingR > 1.15 ? 'fly' : 'wall';
			}
			if (top < 4) {
				top = 4;
				slot.tossVY = Math.abs(slot.tossVY) * 0.42;
				slot.tossBounces += 1;
				if (!note) { note = 'ceil'; }
			}
			var floorTop = viewH - sh * 0.82;
			if (floorTop < 8) { floorTop = 8; }
			// Only the way down. An upward flick that started below the fold
			// has to be allowed to climb out.
			if (top > floorTop && slot.tossVY > 0) {
				var incomingDown = slot.tossVY;
				top = floorTop;
				slot.tossVY = -incomingDown * 0.36;
				slot.tossVX *= 0.62;
				slot.tossBounces += 1;
				if (!note && incomingDown > 0.55) { note = 'boing'; }
			}
			el.style.left = Math.round(left) + 'px';
			el.style.top = Math.round(top) + 'px';
			if (slot.model) {
				slot.model.x = left + sw / 2;
				slot.model.y = top + sh;
				var tilt = slot.tossVX * 0.22;
				if (tilt > 0.4) { tilt = 0.4; } else if (tilt < -0.4) { tilt = -0.4; }
				slot.model.rotation = tilt;
			}
			if (note) { tossNote(slot, note); }
			if (tryCatch(slot)) { continue; }
			var speed = Math.abs(slot.tossVX) + Math.abs(slot.tossVY);
			var onFloor = top >= floorTop - 1;
			if ((onFloor && (speed < 0.18 || slot.tossBounces >= 4)) || slot.tossBounces >= 8) {
				if (!onFloor) {
					top = floorTop;
					el.style.top = Math.round(top) + 'px';
					if (slot.model) { slot.model.y = top + sh; }
				}
				landToss(slot);
			}
		}
		if (any) { tossRaf = window.requestAnimationFrame(stepToss); }
	}

	function landToss(slot) {
		commitDropFromElement(slot);
		slot.tossing = false;
		slot.tossT = 0;
		if (slot.model) { slot.model.rotation = 0; }
		if (slot.tossWillDizzy) {
			slot.tossWillDizzy = false;
			startDizzy(slot);
			return;
		}
		if (reactToCompany(slot, 'land')) { return; }
		if (!slot.tossSaid) { playGag(slot, 'tossLand'); }
	}

	function overlapRatio(a, b) {
		var iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
		var ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
		if (iw <= 0 || ih <= 0) { return 0; }
		var areaA = Math.max(1, a.width * a.height);
		var areaB = Math.max(1, b.width * b.height);
		return (iw * ih) / Math.min(areaA, areaB);
	}

	function notePlay(actor, opt) {
		lastPlayAt = Date.now();
		dazedIdle = false;
		yawnedIdle = false;
		var quiet = opt && opt.quiet;
		var woken = [];
		for (var i = 0; i < slots.length; i++) {
			var slot = slots[i];
			if (!slot.dozing) { continue; }
			slot.dozing = false;
			if (slot.dozePulse) {
				window.clearInterval(slot.dozePulse);
				slot.dozePulse = 0;
			}
			if (slot.el) {
				var zzz = slot.el.querySelector('.mascot-zzz');
				if (zzz && zzz.parentNode) { zzz.parentNode.removeChild(zzz); }
			}
			woken.push(slot);
		}
		if (!woken.length) {
			lastWoken = [];
			return;
		}
		if (quiet || !actor) {
			lastWoken = [];
			if (!quiet) { playGag(woken[0], 'wake'); }
			return;
		}
		lastWoken = woken;
	}

	function beginDoze(slot) {
		if (!slot.el || !slot.model || slot.dozing || slot.dragging || slot.tossing || slot.petting) { return; }
		slot.dozing = true;
		var zzz = document.createElement('span');
		zzz.className = 'mascot-zzz';
		zzz.textContent = '💤';
		slot.el.appendChild(zzz);
		playNamed(slot, 'doze');
		slot.dozePulse = window.setInterval(function () {
			if (slot.dozing) { playNamed(slot, 'doze'); }
		}, 3000);
	}

	function scheduleDoze() {
		clearTimeout(dozeTimer);
		dozeTimer = window.setTimeout(function () {
			dozeTimer = 0;
			if (!destroyed && !document.hidden) {
				var quiet = Date.now() - lastPlayAt;
				var chimed = chimeIfNew();
				var live = liveSlots();
				if (!chimed && live.length && quiet >= DOZE_AFTER_MS) {
					var asleep = false;
					for (var n = 0; n < slots.length; n++) {
						if (slots[n].dozing) { asleep = true; break; }
					}
					if (!asleep) { beginDoze(pick(live)); }
				} else if (!chimed && live.length && quiet >= YAWN_AFTER_MS && !yawnedIdle) {
					yawnedIdle = true;
					playGag(pick(live), 'yawn');
				} else if (!chimed && live.length && quiet >= DAZE_AFTER_MS && !dazedIdle) {
					dazedIdle = true;
					playGag(pick(live), 'daze');
				}
			}
			if (!destroyed) { scheduleDoze(); }
		}, 15000);
	}

	/** Right-click on a dragged mascot: drop the custom position and return
	 *  it to the default queue spot next to the composer. */
	function resetSlot(slot) {
		if (!slot.custom && !slot.tossing) { return; }
		slot.tossing = false;
		if (slot.model) { slot.model.rotation = 0; }
		slot.custom = null;
		scheduleLayout();
		var cb = window.ZCodeMascots && window.ZCodeMascots.onReset;
		if (cb) { cb(slot.id); }
		playGag(slot, 'home');
	}

	function motionDefinitions(model) {
		return model && model.internalModel && model.internalModel.motionManager
			? model.internalModel.motionManager.definitions
			: null;
	}

	/**
	 * Real parameter range, or null. getParameterIndex invents a slot for
	 * unknown ids, so a hit only counts when the index is inside the model.
	 */
	function paramRange(core, id) {
		var count = core.getParameterCount();
		var idx = core.getParameterIndex(id);
		if (idx < 0 || idx >= count) { return null; }
		var min = core.getParameterMinimumValue(idx);
		var max = core.getParameterMaximumValue(idx);
		var def = core.getParameterDefaultValue(idx);
		if (!(max > min)) { return null; }
		return { min: min, max: max, def: def };
	}

	/** Fraction of (default → max) or (default → min) into a clamped value. */
	function sampleRange(range, fraction) {
		var v = fraction >= 0
			? range.def + fraction * (range.max - range.def)
			: range.def + fraction * (range.def - range.min);
		if (v > range.max) { v = range.max; }
		if (v < range.min) { v = range.min; }
		return v;
	}

	function linearCurve(id, keys) {
		var segs = [keys[0][0], keys[0][1]];
		for (var i = 1; i < keys.length; i++) {
			segs.push(0, keys[i][0], keys[i][1]);
		}
		return { Target: 'Parameter', Id: id, Segments: segs };
	}

	function sharedMotionJson(curves, duration, fadeIn, fadeOut) {
		var totalSeg = 0;
		for (var i = 0; i < curves.length; i++) {
			totalSeg += (curves[i].Segments.length - 2) / 3;
		}
		return {
			Version: 3,
			Meta: {
				Duration: duration,
				Fps: 30,
				Loop: false,
				AreBeziersRestricted: true,
				CurveCount: curves.length,
				TotalSegmentCount: totalSeg,
				TotalPointCount: totalSeg + curves.length,
				UserDataCount: 0,
				TotalUserDataSize: 0,
				FadeInTime: fadeIn,
				FadeOutTime: fadeOut,
			},
			Curves: curves,
		};
	}

	/** Build one shared motion against this model. False when no part matched. */
	function startSharedMotion(slot, def) {
		var internal = slot.model && slot.model.internalModel;
		var mm = internal && internal.motionManager;
		var core = internal && internal.coreModel;
		if (!mm || !core || typeof mm.createMotion !== 'function' || typeof mm._startMotion !== 'function') {
			return false;
		}
		var curves = [];
		var duration = 0;
		for (var p = 0; p < def.parts.length; p++) {
			var part = def.parts[p];
			var range = null;
			var id = null;
			for (var c = 0; c < part.ids.length; c++) {
				range = paramRange(core, part.ids[c]);
				if (range) { id = part.ids[c]; break; }
			}
			if (!range || part.keys.length < 2) { continue; }
			var keys = [];
			var travel = 0;
			for (var k = 0; k < part.keys.length; k++) {
				var t = part.keys[k][0];
				var v = sampleRange(range, part.keys[k][1]);
				keys.push([t, v]);
				if (t > duration) { duration = t; }
				var delta = Math.abs(v - range.def);
				if (delta > travel) { travel = delta; }
			}
			// A flat curve would only pin the parameter at its default.
			if (travel < Math.max(0.01, (range.max - range.min) * 0.02)) { continue; }
			curves.push(linearCurve(id, keys));
		}
		if (!curves.length) { return false; }
		var fadeIn = def.fadeIn != null ? def.fadeIn : 0.35;
		var fadeOut = def.fadeOut != null ? def.fadeOut : 0.5;
		try {
			var motion = mm.createMotion(sharedMotionJson(curves, duration, fadeIn, fadeOut), 'Shared', {
				FadeInTime: fadeIn,
				FadeOutTime: fadeOut,
			});
			motionGen += 1;
			mm._startMotion(motion);
			return true;
		} catch (e) {
			return false;
		}
	}

	function shuffle(list) {
		var copy = list.slice();
		for (var i = copy.length - 1; i > 0; i--) {
			var j = Math.floor(Math.random() * (i + 1));
			var tmp = copy[i];
			copy[i] = copy[j];
			copy[j] = tmp;
		}
		return copy;
	}

	/** One shared gesture, chosen at random. Blink is last: it is easy to
	 *  match and easy to miss, so a nod or a wave should win when it can. */
	function playShared(slot) {
		if (!slot.model) { return false; }
		var body = [];
		var blink = null;
		for (var i = 0; i < SHARED_MOTIONS.length; i++) {
			if (SHARED_MOTIONS[i].id === 'blink') { blink = SHARED_MOTIONS[i]; }
			else if (SHARED_MOTIONS[i].id === 'doze') { continue; }
			else { body.push(SHARED_MOTIONS[i]); }
		}
		var order = shuffle(body);
		if (blink) { order.push(blink); }
		for (var n = 0; n < order.length; n++) {
			if (startSharedMotion(slot, order[n])) { return true; }
		}
		return false;
	}

	/** touch_/main_/head clips that live outside Idle/TapBody/Tap/Shake. */
	function looseClips(model) {
		if (model.__zcodeLooseClips) { return model.__zcodeLooseClips; }
		var defs = motionDefinitions(model);
		var clips = [];
		if (defs) {
			Object.keys(defs).forEach(function (group) {
				if (FIDGET_GROUPS.indexOf(group) !== -1) { return; }
				var list = defs[group] || [];
				for (var i = 0; i < list.length; i++) {
					var file = (list[i] && (list[i].File || list[i].file)) || '';
					var base = String(file).split('/').pop().toLowerCase();
					if (!LOOSE_KEEP_RE.test(base)) { continue; }
					clips.push({ file: file });
				}
			});
		}
		model.__zcodeLooseClips = clips;
		return clips;
	}

	/** Fetch a loose clip, force it one-shot, and give up when it is a pose pop or a scene.
	 *  `opts.onReject` replaces the shared-motion fallback; `opts.max` widens the duration cap. */
	function playLooseClip(slot, clip, opts) {
		var reject = (opts && opts.onReject) || function () { playShared(slot); };
		var max = (opts && opts.max) || LOOSE_MAX_SEC;
		var gen = (motionGen += 1);
		var modelUrl = slot.url;
		var fileUrl;
		try {
			fileUrl = new URL(clip.file, modelUrl).href;
		} catch (e) {
			if (gen === motionGen) { reject(); }
			return;
		}
		fetch(fileUrl).then(function (res) {
			if (!res.ok) { throw new Error('motion ' + res.status); }
			return res.json();
		}).then(function (json) {
			if (gen !== motionGen || destroyed || slot.url !== modelUrl || !slot.model) { return; }
			var dur = json && json.Meta && json.Meta.Duration;
			if (!dur || dur < LOOSE_MIN_SEC || dur > max) {
				reject();
				return;
			}
			if (json.Meta) { json.Meta.Loop = false; }
			var mm = slot.model.internalModel.motionManager;
			var motion = mm.createMotion(json, 'Own', { FadeInTime: 0.4, FadeOutTime: 0.55 });
			motionGen += 1;
			mm._startMotion(motion);
		}).catch(function () {
			if (gen !== motionGen) { return; }
			reject();
		});
	}

	/** Own clips a click may start. Idle and breath stay out; the unnamed group
	 *  (game rips) only contributes real reactions, not 1-frame face poses. */
	function clickClips(model) {
		var groups = motionDefinitions(model);
		if (!groups) { return []; }
		var clips = [];
		Object.keys(groups).forEach(function (name) {
			if (name === 'Idle' || name === 'idle') { return; }
			var list = groups[name] || [];
			var unnamed = name === '';
			for (var i = 0; i < list.length; i++) {
				var file = (list[i] && (list[i].File || list[i].file)) || '';
				if (!file) { continue; }
				var base = String(file).split('/').pop().toLowerCase();
				if (/idle|breath/.test(base)) { continue; }
				if (unnamed && !CLICK_FILE_RE.test(base)) { continue; }
				clips.push({ file: file });
			}
		});
		return clips;
	}

	/** Model hit area when the click lands in one; otherwise the slot is split
	 *  into head / body / feet. Many game rips ship no hit areas. */
	function pokeZone(slot, event) {
		var names = '';
		if (slot.model && event && typeof slot.model.hitTest === 'function') {
			try {
				var hit = slot.model.hitTest(event.clientX, event.clientY);
				if (hit && hit.length) { names = hit.join(' ').toLowerCase(); }
			} catch (e) { names = ''; }
		}
		if (names) {
			if (/ear/.test(names)) { return 'ear'; }
			if (/head|hair|face/.test(names)) { return 'head'; }
			if (/foot|leg|skirt/.test(names)) { return 'foot'; }
			if (/body|bust|chest|belly/.test(names)) { return 'body'; }
		}
		if (!slot.el || !event) { return 'body'; }
		var rect = slot.el.getBoundingClientRect();
		var ry = (event.clientY - rect.top) / Math.max(1, rect.height);
		if (ry < 0.32) { return 'head'; }
		if (ry > 0.74) { return 'foot'; }
		return 'body';
	}

	function playNamed(slot, id) {
		var def = null;
		for (var i = 0; i < SHARED_MOTIONS.length; i++) {
			if (SHARED_MOTIONS[i].id === id) { def = SHARED_MOTIONS[i]; break; }
		}
		return !!(def && startSharedMotion(slot, def));
	}

	function sparksAllowed() {
		return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
	}

	/** Gift and sparks are children of the slot, so they follow a drag.
	 *  The cap drops the oldest bits if a pet is held for a long time. */
	function spawnBits(slot, clientX, clientY, spec) {
		if (!slot.el || !sparksAllowed()) { return; }
		var rect = slot.el.getBoundingClientRect();
		var baseX = clientX - rect.left;
		var baseY = clientY - rect.top;
		var count = spec.count || 0;
		var nodes = slot.el.querySelectorAll('.mascot-spark, .mascot-gift');
		var overflow = nodes.length + (spec.gift ? 1 : 0) + count - 30;
		for (var n = 0; n < overflow; n++) { nodes[n].remove(); }
		if (spec.gift) {
			var gift = document.createElement('span');
			gift.className = 'mascot-gift';
			gift.textContent = spec.gift;
			gift.style.left = Math.round(baseX) + 'px';
			gift.style.top = Math.round(baseY) + 'px';
			slot.el.appendChild(gift);
			retireBit(gift, 1900);
		}
		var glyphs = spec.glyphs || HEARTS;
		for (var i = 0; i < count; i++) {
			var bit = document.createElement('span');
			bit.className = 'mascot-spark';
			bit.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
			bit.style.left = Math.round(baseX + (Math.random() - 0.5) * 18) + 'px';
			bit.style.top = Math.round(baseY + (Math.random() - 0.5) * 10) + 'px';
			bit.style.setProperty('--dx', Math.round((Math.random() - 0.5) * 64) + 'px');
			bit.style.setProperty('--dy', Math.round(-(46 + Math.random() * 54)) + 'px');
			bit.style.animationDelay = (i * 35) + 'ms';
			slot.el.appendChild(bit);
			retireBit(bit, 1200 + i * 35);
		}
	}

	function retireBit(el, ms) {
		var gone = false;
		function remove() {
			if (gone) { return; }
			gone = true;
			if (el.parentNode) { el.parentNode.removeChild(el); }
		}
		el.addEventListener('animationend', remove);
		window.setTimeout(remove, ms);
	}

	/** Click: a gift appears at the pointer, the zone picks the gesture
	 *  (head smiles, ears twitch, feet lean; the torso still plays one of the
	 *  model's own clips). Two quick clicks are a signal, three a flurry,
	 *  five a gift storm. A poke that wakes a sleeper stretches instead. */
	function onTap(slot, event, wasDozing) {
		if (!slot.model) { return; }
		if (wasDozing) {
			lastWoken = [];
			playGag(slot, 'wake');
			return;
		}
		if (event && event.target && event.target.closest && event.target.closest('.mascot-bubble')) {
			speakWoken(slot);
			playGag(slot, 'popLine');
			return;
		}
		var now = Date.now();
		if (lastPass.slot && lastPass.slot !== slot && lastPass.slot.el && now - lastPass.at < 1600) {
			var from = lastPass.slot;
			lastPass = { slot: null, at: 0 };
			speakWoken(slot);
			playPair(from, { kind: 'pass', other: slot });
			return;
		}
		lastPass = { slot: slot, at: now };
		speakWoken(slot);
		var zone = pokeZone(slot, event);
		if (zone === 'head' && event && slot.el) {
			var rect = slot.el.getBoundingClientRect();
			var rx = (event.clientX - rect.left) / Math.max(1, rect.width);
			if (rx < 0.2 || rx > 0.8) { zone = 'ear'; }
		}
		if (!slot.taps) { slot.taps = []; }
		slot.taps = slot.taps.filter(function (t) { return now - t < 2200; });
		slot.taps.push(now);
		var n = slot.taps.length;
		var x = event ? event.clientX : 0;
		var y = event ? event.clientY : 0;
		if (n >= 5) {
			slot.taps = [];
			playGag(slot, 'storm');
			return;
		}
		if (n === 4) {
			if (!playNamed(slot, 'smile')) { playNamed(slot, 'wave'); }
			spawnBits(slot, x, y, { glyphs: HEARTS, count: 3 });
			return;
		}
		if (n === 3 && now - slot.taps[0] < TAP_COMBO_MS) {
			var gift3 = pick(GIFTS);
			spawnBits(slot, x, y, { gift: gift3.glyph, glyphs: HEARTS, count: 9 });
			if (!playNamed(slot, 'smile')) { playNamed(slot, 'wave'); }
			voiceSay(slot, 'combo', personaLine(slot, 'combo', COMBO_LINES), { zone: zone, gift: gift3.glyph });
			return;
		}
		if (n === 2 && now - slot.taps[0] < 420) {
			playGag(slot, 'double');
			return;
		}
		var gift = pick(GIFTS);
		spawnBits(slot, x, y, {
			gift: gift.glyph,
			glyphs: SPARKS[zone] || SPARKS.body,
			count: 4,
		});
		var gestured = false;
		if (zone === 'ear') { gestured = playNamed(slot, 'ears') || playNamed(slot, 'smile'); }
		else if (zone === 'head') { gestured = Math.random() < 0.7 && playNamed(slot, 'smile'); }
		else if (zone === 'foot') { gestured = playNamed(slot, 'lean') || playNamed(slot, 'shake'); }
		if (!gestured) {
			var pending = shuffle(clickClips(slot.model));
			var left = Math.min(pending.length, 6);
			function next() {
				if (!left || !pending.length) {
					playShared(slot);
					return;
				}
				left -= 1;
				playLooseClip(slot, pending.pop(), { max: CLICK_MAX_SEC, onReject: next });
			}
			next();
		}
		var zoneKind = zone === 'head' || zone === 'ear' || zone === 'foot' ? zone : 'tap';
		var zoneLines = ZONE_LINES[zone] || TAP_LINES;
		var spoken = Math.random() < 0.5 ? personaGift(slot, gift.glyph, gift.line) : personaLine(slot, zoneKind, zoneLines);
		voiceSay(slot, 'tap', spoken, { zone: zone, gift: gift.glyph });
	}

	/** Keeps a one-line bubble inside the panel. The tail still points at the
	 *  character. A line wider than the panel is the only case that wraps. */
	function placeBubble(bubble) {
		if (!bubble || !bubble.parentElement) { return; }
		bubble.style.whiteSpace = '';
		bubble.style.maxWidth = '';
		bubble.style.setProperty('--bubble-nudge', '0px');
		bubble.style.setProperty('--bubble-tail', '0px');
		var margin = 8;
		var viewW = window.innerWidth || document.documentElement.clientWidth;
		var limit = Math.max(120, viewW - margin * 2);
		if (bubble.scrollWidth > limit) {
			bubble.style.whiteSpace = 'normal';
			bubble.style.maxWidth = limit + 'px';
		}
		var slotRect = bubble.parentElement.getBoundingClientRect();
		var width = bubble.offsetWidth;
		var left = slotRect.left + slotRect.width / 2 - width / 2;
		var dx = 0;
		if (left + width > viewW - margin) {
			dx -= (left + width) - (viewW - margin);
		}
		if (left + dx < margin) {
			dx += margin - (left + dx);
		}
		dx = Math.round(dx);
		var maxTail = Math.max(0, width / 2 - 14);
		var tail = dx;
		if (tail > maxTail) { tail = maxTail; }
		else if (tail < -maxTail) { tail = -maxTail; }
		bubble.style.setProperty('--bubble-nudge', dx + 'px');
		bubble.style.setProperty('--bubble-tail', Math.round(tail) + 'px');
	}

	/** Shows a bubble above the character. Replaces any current line. */
	function say(slot, text, ms) {
		if (!slot.el) { return; }
		var bubble = slot.el.querySelector('.mascot-bubble');
		if (!bubble) {
			bubble = document.createElement('div');
			bubble.className = 'mascot-bubble';
			slot.el.appendChild(bubble);
		}
		bubble.textContent = text;
		placeBubble(bubble);
		tryTts(slot, text);
		bubble.classList.add('show');
		window.clearTimeout(slot.bubble);
		slot.bubble = window.setTimeout(function () {
			bubble.classList.remove('show');
		}, ms || BUBBLE_SECONDS);
	}

	/** Local line for this character's persona. Generic bank is the last resort. */
	function personaPack(slot) {
		var id = slot && slot.persona;
		var list = state && state.personas;
		if (!id || !list) { return null; }
		for (var i = 0; i < list.length; i++) {
			if (list[i].id === id) { return list[i]; }
		}
		return null;
	}

	function personaLine(slot, kind, generic) {
		var pack = personaPack(slot);
		var lines = pack && pack.lines && pack.lines[kind];
		if (lines && lines.length) { return pick(lines); }
		return pick(generic);
	}

	function personaGift(slot, glyph, generic) {
		var pack = personaPack(slot);
		var gifts = pack && pack.lines && pack.lines.gifts;
		if (gifts && gifts[glyph]) { return gifts[glyph]; }
		return generic;
	}

	/** Asks GLM Flash for this line. A click inside VOICE_COOLDOWN_MS keeps the
	 *  local fallback so a flurry of taps does not fire a request each time.
	 *  The bubble stays hidden until the line arrives, then shows that line.
	 *  The fallback shows if the call is skipped or times out. */
	/** Speech motion rules: first keyword match picks the motion, so the
	 *  order below is the priority. Applied to host/AI lines and to the
	 *  chatter / dispatch / complete fallbacks; interaction lines already
	 *  play a matching motion with their reaction. */
	var SPEECH_MOTION_RULES = [
		{ re: /(哈啊|打盹|犯困|好困|想睡|哈欠|晚安|再睡|眯|💤|🥱)/, motion: 'doze' },
		{ re: /(谢谢|喜欢|好棒|厉害|漂亮|开心|可爱|好喝|好香|好暖|甜|舒服|安心|做好|搞定|完成|收工|归港|拿下|好厉害|❤|💗|💖|😊|😄|😆)/, motion: 'smile' },
		{ re: /(欢迎|来啦|你来|早安|早上好|再见|出击|开工|下一个|击掌|🎉|👋)/, motion: 'wave' },
		{ re: /(为什么|什么|怎么|咦|诶|欸|吗|呢|\?|？)/, motion: 'tilt' },
		{ re: /(哼|讨厌|不要|不行|疼|痛|哎哟|生气|气人|💥)/, motion: 'lean' }
	];
	/** Persona flavor when the line has no keyword hit. */
	var PERSONA_SPEECH_MOTION = {
		soft: 'smile', sunny: 'wave', gentle: 'nod', cool: 'nod', tsun: 'tilt',
		sharp: 'tilt', sleepy: 'doze', shy: 'look', senior: 'nod', boy: 'wave',
		imp: 'lean', snack: 'smile', drama: 'wave', ship: 'nod', fox: 'ears',
		cat: 'ears', miko: 'nod', goth: 'look', clerk: 'wave', bot: 'nod',
		slime: 'lean'
	};
	/** Plays a motion that fits the line being spoken: keyword match first,
	 *  then the persona's flavor, then the trigger's default. Models without
	 *  the parameter set (e.g. no ears) fall back to the talking motion. */
	function playSpeechMotion(slot, text, trigger) {
		if (!slot || !slot.model || destroyed) { return; }
		// Interaction triggers already played a matching reaction motion.
		if (trigger !== 'chatter' && trigger !== 'dispatch' && trigger !== 'complete') { return; }
		var line = String(text || '');
		var motion = '';
		for (var i = 0; i < SPEECH_MOTION_RULES.length; i++) {
			if (SPEECH_MOTION_RULES[i].re.test(line)) { motion = SPEECH_MOTION_RULES[i].motion; break; }
		}
		if (!motion) { motion = PERSONA_SPEECH_MOTION[slot.persona || ''] || ''; }
		if (!motion) {
			motion = trigger === 'complete' ? 'smile' : trigger === 'dispatch' ? 'nod' : 'talk';
		}
		if (!playNamed(slot, motion)) { playNamed(slot, 'talk'); }
	}

	var VOICE_COOLDOWN_MS = 1200;
	var voiceNextAt = 0;
	var voiceSeq = 0;
	function hideBubble(slot) {
		if (!slot.el) { return; }
		var bubble = slot.el.querySelector('.mascot-bubble');
		window.clearTimeout(slot.bubble);
		slot.bubble = 0;
		if (bubble) { bubble.classList.remove('show'); }
	}
	function voiceSay(slot, trigger, fallback, extra) {
		var now = Date.now();
		if (now < voiceNextAt) {
			say(slot, fallback);
			playSpeechMotion(slot, fallback, trigger);
			return;
		}
		voiceNextAt = now + VOICE_COOLDOWN_MS;
		var seq = ++voiceSeq;
		slot.voiceSeq = seq;
		slot.voiceTrigger = trigger;
		slot.voiceFallback = fallback;
		window.clearTimeout(slot.voiceTimer);
		hideBubble(slot);
		slot.voiceTimer = window.setTimeout(function () {
			if (slot.voiceSeq !== seq) { return; }
			say(slot, fallback);
			playSpeechMotion(slot, fallback, slot.voiceTrigger);
		}, 9000);
		var cb = window.ZCodeMascots && window.ZCodeMascots.onSpeak;
		if (!cb) {
			window.clearTimeout(slot.voiceTimer);
			say(slot, fallback);
			playSpeechMotion(slot, fallback, trigger);
			return;
		}
		cb({
			seq: seq,
			id: slot.id || '',
			label: slot.label || '',
			trigger: trigger,
			zone: (extra && extra.zone) || '',
			gift: (extra && extra.gift) || '',
		});
	}

	/** Host reply for one voiceSay. A stale seq (she was tapped again) is dropped. */
	function hear(seq, line, skipped) {
		for (var i = 0; i < slots.length; i++) {
			var slot = slots[i];
			if (slot.voiceSeq !== seq) { continue; }
			window.clearTimeout(slot.voiceTimer);
			slot.voiceTimer = 0;
			if (skipped || !line) {
				say(slot, slot.voiceFallback || pick(TAP_LINES));
				playSpeechMotion(slot, slot.voiceFallback || '', slot.voiceTrigger);
				return;
			}
			say(slot, line, 5600);
			playSpeechMotion(slot, line, slot.voiceTrigger);
			return;
		}
	}

	function scheduleChatter() {
		clearTimeout(chatterTimer);
		chatterTimer = window.setTimeout(function () {
			chatterTimer = 0;
			var live = slots.filter(function (slot) { return slot.model; });
			if (!live.length || document.hidden) {
				scheduleChatter();
				return;
			}
			notePlay();
			chatterSeq += 1;
			voiceSay(live[chatterSeq % live.length], 'chatter', personaLine(live[chatterSeq % live.length], 'chatter', CHATTER_LINES));
			scheduleChatter();
		}, CHATTER_MIN_MS + Math.random() * (CHATTER_MAX_MS - CHATTER_MIN_MS));
	}

	/** Groups the model actually ships that we may fidget with. */
	function availableFidgetGroups(model) {
		var groups = motionDefinitions(model);
		if (!groups) { return []; }
		return FIDGET_GROUPS.filter(function (name) {
			return groups[name] && groups[name].length;
		});
	}

	/** Own clip when the model has one, otherwise a shared human motion.
	 *  Models that already have Idle/TapBody still take the shared set about
	 *  half the time, so the common gestures show up on every character.
	 *  A model with neither gets only the shared set — the curves are built
	 *  from parameter ids at play time, not copied into the model files. */
	function cueBody(slot, force) {
		if (!slot.model) { return; }
		var named = availableFidgetGroups(slot.model);
		if (force) {
			named = named.filter(function (name) { return name !== 'Idle'; });
		}
		var loose = looseClips(slot.model);
		if (!named.length && !loose.length) {
			playShared(slot);
			return;
		}
		if (Math.random() < 0.55) {
			if (named.length && (!loose.length || Math.random() < 0.5)) {
				playMotion(slot, pick(named), force);
				return;
			}
			if (loose.length) {
				playLooseClip(slot, pick(loose));
				return;
			}
		}
		if (!playShared(slot)) {
			if (named.length) { playMotion(slot, pick(named), force); }
			else if (loose.length) { playLooseClip(slot, pick(loose)); }
		}
	}

	/** Idle fidgets: every 9–22 s one mascot plays a single motion, then rests.
	 *  The looping idle body-bob stays off; this is one gesture at a time. */
	function scheduleFidget() {
		clearTimeout(fidgetTimer);
		fidgetTimer = window.setTimeout(function () {
			fidgetTimer = 0;
			var live = slots.filter(function (slot) {
				return slot.model && !slot.dozing && !slot.tossing;
			});
			if (live.length && !document.hidden) {
				cueBody(pick(live), false);
			}
			scheduleFidget();
		}, FIDGET_MIN_MS + Math.random() * (FIDGET_MAX_MS - FIDGET_MIN_MS));
	}

	/** Plays one motion on a slot; `force` bumps priority to FORCE so task
	 * reactions are not swallowed by an in-flight fidget. */
	function playMotion(slot, group, force) {
		if (!slot.model) { return; }
		motionGen += 1;
		try {
			slot.model.internalModel.motionManager.startRandomMotion(group, force ? MOTION_FORCE : undefined);
		} catch (e) { /* motion hiccup is fine */ }
	}

	/** Task lifecycle reactions, called from chatView ('dispatch' /
	 * 'complete'). The cooldown keeps flickering busy flags from
	 * machine-gunning motions. */
	function react(kind) {
		var now = Date.now();
		if (now - lastReactAt < REACT_COOLDOWN_MS) { return; }
		notePlay();
		var live = slots.filter(function (slot) { return slot.model && !slot.tossing; });
		if (!live.length || document.hidden) { return; }
		lastReactAt = now;
		var slot = pick(live);
		if (kind === 'complete') {
			if (!playNamed(slot, 'smile')) { playNamed(slot, 'wave'); }
		} else if (!playNamed(slot, 'wave')) {
			cueBody(slot, true);
		}
		var voiceKind = kind === 'complete' ? 'complete' : 'dispatch';
		voiceSay(slot, voiceKind, personaLine(slot, voiceKind, voiceKind === 'complete' ? COMPLETE_LINES : DISPATCH_LINES));
	}

	function onVisibilityChange() {
		if (!app) { return; }
		if (document.hidden) {
			app.ticker.stop();
		} else if (!(narrowMedia && narrowMedia.matches)) {
			app.ticker.start();
		}
	}

	function onNarrowChange() {
		if (!app || !layer) { return; }
		var hidden = !!(narrowMedia && narrowMedia.matches);
		if (hidden) {
			layer.classList.add('mascot-narrow');
			app.ticker.stop();
		} else {
			layer.classList.remove('mascot-narrow');
			if (!document.hidden) {
				app.ticker.start();
			}
		}
	}

	var layoutScheduled = 0;
	function scheduleLayout() {
		if (layoutScheduled) { return; }
		layoutScheduled = window.setTimeout(function () {
			layoutScheduled = 0;
			layout();
		}, 60);
	}

	/** This character's on-screen box. Wheel and the per-model slider store a
	 *  height on the slot; the global slider is only the fallback. */
	function slotBox(slot) {
		var h = slot && slot.height > 0 ? slot.height : currentSizePx();
		return { h: h, w: Math.round(h * 0.78) };
	}

	/** Full-viewport layer, absolutely placed slots. Dragged slots sit exactly
	 *  where they were dropped (normalized x/y); the rest queue to the right
	 *  of the composer, feet sunk past the fold (OVERHANG clips the legs).
	 *
	 *  The grab target and the speech bubble are both the slot element, and
	 *  the model is anchored to that element's bottom edge. The box therefore
	 *  has to be this character's own height. Placing it with the global
	 *  slider height shifts the box down the body whenever a character is
	 *  taller than the slider: the upper half sticks out of the grab area
	 *  (so dragging the torso does nothing) and the line sits at the waist. */
	function layout() {
		if (!app || !layer) { return; }
		var W = window.innerWidth || document.documentElement.clientWidth;
		var H = window.innerHeight || document.documentElement.clientHeight;
		var composer = document.getElementById('composer');
		var rect = composer && composer.isConnected ? composer.getBoundingClientRect() : null;

		var defaults = slots.filter(function (slot) { return slot.el && !slot.custom && !slot.dragging; });
		var sumW = 0;
		for (var i = 0; i < defaults.length; i++) { sumW += slotBox(defaults[i]).w; }
		var gap = 12;
		var startLeft = rect
			? Math.round(rect.right) + 16
			: Math.max(12, W - 14 - sumW - gap * Math.max(0, defaults.length - 1));
		var room = Math.max(80, W - 8 - startLeft);
		if (defaults.length > 1 && sumW + gap * (defaults.length - 1) > room) {
			// Squeeze neighbours onto each other rather than drifting over the
			// composer or past the panel edge. 0.45 of the average width is
			// the most overlap we allow.
			var squeezed = (room - sumW) / (defaults.length - 1);
			gap = Math.max(-0.45 * (sumW / defaults.length), squeezed);
		}
		var cursor = startLeft;
		slots.forEach(function (slot) {
			if (!slot.el || slot.dragging || slot.tossing) { return; }
			var box = slotBox(slot);
			var cx;
			var bottom;
			if (slot.custom) {
				cx = slot.custom.x * W;
				bottom = slot.custom.y * H;
			} else {
				cx = cursor + box.w / 2;
				bottom = H + box.h * OVERHANG;
				cursor += box.w + gap;
			}
			slot.el.style.width = box.w + 'px';
			slot.el.style.height = box.h + 'px';
			slot.el.style.left = Math.round(cx - box.w / 2) + 'px';
			slot.el.style.top = Math.round(bottom - box.h) + 'px';
			if (slot.model) {
				slot.model.x = cx;
				slot.model.y = bottom; // anchored (0.5, 1) at the slot bottom
			}
			var shown = slot.el.querySelector('.mascot-bubble.show');
			if (shown) { placeBubble(shown); }
		});
		if (Math.round(app.screen.width) !== W || Math.round(app.screen.height) !== H) {
			app.renderer.resize(W, H);
		}
	}

	/** Debug snapshot for the context-menu「精灵状态」item and devtools console. */
	function status() {
		return {
			enabled: !!(state && state.enabled),
			sizePx: currentSizePx(),
			runtime: {
				pixi: !!window.PIXI,
				live2dModel: runtimeReady(),
				cubismCore: !!window.Live2DCubismCore,
			},
			layer: {
				mounted: !!(layer && document.body.contains(layer)),
				narrow: !!(narrowMedia && narrowMedia.matches),
				viewport: window.innerWidth + 'x' + window.innerHeight,
				bottom: layer && layer.style.bottom,
				right: layer && layer.style.right,
				height: layer && layer.style.height,
			},
			slots: slots.map(function (slot) {
				return {
					file: String(slot.url || '').split('/').pop(),
					label: slot.label || '',
					persona: slot.persona || '',
					modelReady: !!slot.model,
					proxy: !!slot.el,
				};
			}),
			vendor: state && state.vendor,
		};
	}

	window.ZCodeMascots = { apply: apply, status: status, react: react, hear: hear };

	/* ---- 语音朗读（本地 TTS）：say() 冒出的每句话都可朗读 ---- */
	var ttsSeq = 0;
	var ttsPending = {};
	var ttsQueue = {};
	var ttsBusy = {};
	var ttsUnlockArmed = false;
	var ttsState = { enabled: false, supported: false, voices: [], voiceMap: {} };
	var TTS_SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

	function ttsCleanText(text) {
		return String(text || '')
			.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}]/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 80);
	}

	/** 台词情绪 → 播放端变速变调，语气跟表情走（true 变调即音高随速度走）。 */
	var TTS_MOOD_RATE = { happy: 1.06, excited: 1.1, sleepy: 0.9, puzzled: 0.97, shy: 0.94, sad: 0.93, neutral: 1 };
	function ttsMoodFor(text) {
		var t = String(text || '');
		if (/哈啊|好困|瞌睡|晚安|想睡|犯困|睡一/.test(t)) { return 'sleepy'; }
		if (/谢谢|喜欢|搞定|收工|完成|开心|好耶|♪|💗|❤/.test(t)) { return 'happy'; }
		if (/出击|冲鸭|加油|来吧|厉害|万岁|交给我|看我的|🎉|✨/.test(t)) { return 'excited'; }
		if (/为什么|怎么办|咦|诶\?|欸\?|？|\?/.test(t)) { return 'puzzled'; }
		if (/哼|讨厌|才不是|笨蛋|不许/.test(t)) { return 'shy'; }
		if (/抱歉|对不起|失败|难过|呜|失误/.test(t)) { return 'sad'; }
		return 'neutral';
	}

	function ttsSend(msg) {
		var api = window.ZCodeMascotTts;
		if (api && typeof api._send === 'function') { api._send(msg); }
	}

	/** 自动播放没解锁时，等用户在面板里的第一次点击，之后就能出声了。 */
	function ttsArmUnlock() {
		if (ttsUnlockArmed) { return; }
		ttsUnlockArmed = true;
		window.addEventListener('pointerdown', function () {
			ttsUnlockArmed = false;
			try {
				var audio = new Audio(TTS_SILENT_WAV);
				audio.volume = 0;
				var played = audio.play();
				if (played && played.catch) { played.catch(function () {}); }
			} catch (err) { /* ignore */ }
		}, { once: true });
	}

	function tryTts(slot, text) {
		if (!ttsState.enabled || !ttsState.supported) { return; }
		var line = ttsCleanText(text);
		if (!line) { return; }
		var id = (slot && slot.id) || '';
		var queue = ttsQueue[id] || (ttsQueue[id] = []);
		if (queue.length && queue[queue.length - 1].text === line) { return; }
		if (queue.length >= 2) { queue.shift(); }
		queue.push({ persona: (slot && slot.persona) || '', text: line });
		ttsArmUnlock();
		ttsPump(id);
	}

	function ttsPump(id) {
		if (ttsBusy[id]) { return; }
		var queue = ttsQueue[id];
		if (!queue || !queue.length) { return; }
		var item = queue.shift();
		var rid = 'tts' + (++ttsSeq);
		var mood = ttsMoodFor(item.text);
		ttsBusy[id] = true;
		ttsPending[rid] = {
			id: id,
			mood: mood,
			timer: window.setTimeout(function () {
				delete ttsPending[rid];
				ttsBusy[id] = false;
				ttsPump(id);
			}, ttsState.timeoutMs || 9000)
		};
		ttsSend({ type: 'mascotTtsSpeak', requestId: rid, id: id, persona: item.persona, text: item.text, mood: mood });
	}

	function ttsFinish(rid, id) {
		var pending = ttsPending[rid];
		if (pending) {
			window.clearTimeout(pending.timer);
			delete ttsPending[rid];
		}
		ttsBusy[id] = false;
		ttsPump(id);
	}

	window.ZCodeMascotTts = {
		state: ttsState,
		/** chatView.js 注入的宿主消息通道。 */
		_send: null,
		onState: function (msg) {
			ttsState.enabled = !!msg.enabled;
			ttsState.supported = !!msg.supported;
			ttsState.voices = Array.isArray(msg.voices) ? msg.voices : [];
			ttsState.voiceMap = msg.voiceMap && typeof msg.voiceMap === 'object' ? msg.voiceMap : {};
			ttsState.timeoutMs = Number(msg.timeoutMs) > 0 ? Number(msg.timeoutMs) : 9000;
			if (!ttsState.enabled) {
				ttsQueue = {};
				ttsBusy = {};
				var ids = Object.keys(ttsPending);
				for (var i = 0; i < ids.length; i++) { window.clearTimeout(ttsPending[ids[i]].timer); }
				ttsPending = {};
			}
			var cb = window.ZCodeMascots && window.ZCodeMascots.onTtsState;
			if (typeof cb === 'function') { cb(ttsState); }
		},
		onAudio: function (msg) {
			var rid = msg && msg.requestId;
			var pending = ttsPending[rid];
			if (!pending) { return; }
			var id = pending.id;
			var finish = function () { ttsFinish(rid, id); };
			if (!msg.base64) { finish(); return; }
			try {
				var audio = new Audio('data:' + (msg.mime || 'audio/wav') + ';base64,' + msg.base64);
				audio.volume = 0.9;
				var mood = msg.mood || pending.mood || 'neutral';
				var moodRate = TTS_MOOD_RATE[mood] || 1;
				if (moodRate !== 1) {
					try {
						audio.preservesPitch = false;
						audio.mozPreservesPitch = false;
						audio.webkitPreservesPitch = false;
						audio.playbackRate = moodRate;
					} catch (err) { /* 该内核不支持变调时按原速播 */ }
				}
				audio.onended = finish;
				audio.onerror = finish;
				var played = audio.play();
				if (played && played.catch) {
					played.catch(function () {
						/* 自动播放被拦：这句放弃，等下一次点击解锁。 */
						finish();
					});
				}
			} catch (err) { finish(); }
		}
	};
}());
