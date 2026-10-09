# Writes narration.json, the lines the film and the voice are made from, out of the rewritten
# script (script_zh.md): one entry per spoken sentence, in the order of the film.
#   python build_narration.py
# zh is the Chinese subtitle and what the voice reads (the voice skill reads the zh field); en is
# the English subtitle. Where the voice must read something other than the subtitle, SPOKEN gives
# the line its own spoken text (the tts field).
import json

# Spoken differently from the subtitle:
# - "UP 主" is said as the word "up" (lower case makes the voice read it as a word, not as letters)
# - the Latin spelling of 书院造 is shown, not read
SPOKEN = {
    'title-3': '我必须补充，是我一位朋友——网名 P小二 的 AI 行业专家，也是著名创业者和up主——在我刚刚上手自学的时候，提示我关注这一算法。',
    # 重 would be read zhong4 here; 崇 has the one reading chong2
    # the studio's name is spoken in Chinese characters: the voice reads the Latin spelling badly
    'origin-5': '当时，当我做这个的时候，我发现已经有先驱在干类似的东西，而且比我更加富有细节。也就是卡卡波比工作室的独立游戏，崇檐。',
    # the name in brackets is for the subtitle only
    'collapse-5': '散漫的结果，看起来就不像相对整齐的宋明官式古建，而更像日本室町时代的武家住宅格式，也称书院造。',
}


# The English version of the film (narrated in English) says some lines differently from the
# English subtitles of the Chinese version: it speaks of Asian classical architecture without
# naming a country, and the thanks to P小二 are shorter. enFilm replaces en there.
EN_FILM = {
    'grid-2': 'For example the grid Stålberg uses in his game design.',
    'grid-3': 'On a gently bent grid, the results show a seemingly organic quality.',
    'grid-4': 'On a strongly twisted grid, they look quite modern, even high-tech.',
    'title-1': 'Today I continue with my experiments in architecture with the wave function collapse algorithm, WFC.',
    'title-3': 'My friend, Mr. P-xiaoer, an engineer and influencer, told me about this algorithm in 2022.',
    'motive-4': 'In 2022, with my floor plan generator only roughly working, I found the next subject to experiment on: Asian classical architecture.',
    'collapse-5': "Loose as they are, they look less like the fairly regular official style of the imperial courts, and more like the warrior residences of Japan's Muromachi period, the style called shoin-zukuri.",
    'origin-5': 'Back then, while I was working on this, I found that pioneers were already doing something similar, and in richer detail than mine. It is the indie game EAVES, by KakaBobi Studio.',
}
# what the English voice reads where the spelling would mislead it
EN_SPOKEN = {
    'origin-5': 'Back then, while I was working on this, I found that pioneers were already doing something similar, and in richer detail than mine. It is the indie game Eaves, by Kaka Bobi Studio.',
    'title-3': 'My friend, Mister P Shiao-er, an engineer and influencer, told me about this algorithm in 2022.',
}


def english_spoken(english):
    return english.replace('Stålberg', 'Stalberg').replace('WFC', 'W F C')


# (name, Chinese, English); the scene is the name without its number
LINES = [
    ('title-1', '今天继续介绍我用波函数坍缩算法，也就是 WFC，在建筑学方面的一些试验。',
     'Today I continue with my experiments in architecture with the wave function collapse algorithm, WFC.'),
    ('title-2', '也涉及到一点我个人学习图形技术的故事。',
     'It is also a little of my own story of learning graphics programming.'),
    ('title-3', '我必须补充，是我一位朋友——网名 P小二 的 AI 行业专家，也是著名创业者和 UP 主——在我刚刚上手自学的时候，提示我关注这一算法。',
     'I should add that it was a friend of mine, known online as P小二, an AI expert, well-known founder and video creator, who pointed me to this algorithm when I had just begun teaching myself.'),

    ('motive-1', 'WFC 算法存在内在局限，不适合解决层次非常丰富的问题。',
     'WFC has inherent limits: it does not suit problems with many layers of hierarchy.'),
    ('motive-2', '但是它适合构建建筑学构造层次的一些基本逻辑。',
     'But it does suit building some of the basic logic at the tectonic level of architecture.'),
    ('motive-3', '我们一旦学会了它，自然要榨取其中的价值。并且从我们本身背景行业出发，吸取其中的启发。',
     'Once we have learned it, we naturally want to squeeze the value out of it and, starting from our own profession, draw inspiration from it.'),
    ('motive-4', '2022 年，在户型生成算法仅仅大致跑通的情况下，我寻找到了下一个实验对象——古建筑。',
     'In 2022, with my floor plan generator only roughly working, I found the next subject to experiment on: classical architecture.'),
    ('motive-5', '古建筑的本质也是层次丰富的，不过它的构造，经常是套路化的。',
     'Classical architecture is also rich in hierarchy by nature, but its construction often follows set routines.'),
    ('motive-6', '这些套路，有时候在表面上定义它自身的形式。',
     'Those routines sometimes define its very form, on the surface.'),

    ('origin-1', '偏巧我当时从 Bruno Simon 的网课上接触了一些三维网页技术，使我有动力开工进行这个实验。',
     "As it happened, I had just picked up some 3D web technology from Bruno Simon's online course, which gave me the drive to start this experiment."),
    ('origin-2', '算法知识来自于 Oskar Stålberg 和 Daniel Shiffman 教授的讲座。',
     'The knowledge of the algorithm came from the talks of Oskar Stålberg and Professor Daniel Shiffman.'),
    ('origin-3', '特别是 Shiffman 教授的讲座，给出了简明、而且我相对擅长的 JavaScript 代码。',
     "Professor Shiffman's lecture in particular gave concise code in JavaScript, a language I am fairly at home in."),
    ('origin-4', '这些就是这个项目的起点。',
     'These are where this project started.'),
    ('origin-5', '当时，当我做这个的时候，我发现已经有先驱在干类似的东西，而且比我更加富有细节。也就是 KakaBobi Studio 的独立游戏《重檐》。',
     'Back then, while I was working on this, I found that pioneers were already doing something similar, and in richer detail than mine. It is the indie game EAVES, by KakaBobi Studio.'),
    ('origin-6', '但是没有关系，实验就是大家各做各的。',
     'But that does not matter: in experiments, everyone does their own.'),

    ('grammar-1', 'WFC 最为人知的用途，是生成游戏关卡。',
     'WFC is best known for generating game levels.'),
    ('grammar-2', '从建筑师的角度，我们看重的，是它作为构造的语法。',
     'From an architect\'s point of view, what we value is its use as a tectonic grammar.'),
    ('grammar-3', '适合自下而上构造化的产生秩序，在构件与构件的交接处。',
     'It suits producing order from the bottom up, tectonically, where one component meets another.'),
    ('grammar-4', '屋脊怎样相接，檐口怎样转角，天沟能不能出现。',
     'How ridges meet, how eaves turn a corner, whether a gutter may appear.'),
    ('grammar-5', '这些交接的规矩，正是传统木构建筑最精炼的知识和一些自然的法则。',
     'These rules of joining are the most distilled knowledge of traditional timber architecture, and some laws of nature.'),
    ('grammar-6', '在它形成一个构造基础之上，要施加什么更宏观的秩序，是另外一个层次的问题。',
     'What larger order to impose on top of this tectonic base is a question on another level.'),
    ('grammar-7', '我们这个实验是暂时排除更上层问题的。那是下一个实验的问题。',
     'This experiment sets those higher questions aside for now. They belong to the next experiment.'),

    ('edge-1', '积木的种类是非常有限的，阴角、阳角、边缘、中腹，几种不同的形式而已。',
     'The kinds of block are very few: inside corners, outside corners, edges and middles, only a handful of forms.'),
    ('edge-2', '两个块相邻，只要相对的两条边的剖面吻合，就能拼在一起。',
     'Two neighbouring blocks fit together as long as the sections of their facing edges agree.'),
    ('edge-3', '代码实际上简单得惊人，只是把每块积木的边缘编码，每个边缘用 3 个字符表示。',
     'The code is surprisingly simple: it just encodes the edges of every block, three characters to an edge.'),
    ('edge-4', '这些字符是对这些边缘形状的抽象，主要表示高度轮廓。',
     'The characters abstract the shape of an edge, mainly its profile of heights.'),
    ('edge-5', '0 是地面，-1 是水底；1 是檐口，2 是进深较浅部分的矮脊，3 是进深较大的房屋的高的屋脊，4，是二层的檐口。',
     'Zero is the ground and minus one the water bottom; one is the eave, two the low ridge of the shallower part, three the high ridge of the deeper building, and four the eave of the upper storey.'),
    ('edge-6', '用一些条件语句来判断两块积木的边能否拼合。拼合不了的地方会给出报警。',
     'A few conditional statements decide whether two edges can join. Where they cannot, a warning is shown.'),
    ('edge-7', '有个别的情况需要人为写一些代码来排除。',
     'A few cases have to be ruled out with code written by hand.'),
    ('edge-8', '比如，两片下坡的屋面不能对撞，形成积水的天沟；两个凹角不能相对，形成一个坑。',
     'For example, two roofs sloping down may not meet in a gutter that holds water, and two valley corners may not face each other and form a pit.'),

    ('sketch-1', '这些规则，最早是在笔记本上一格一格画出来的。每个块编号，每条边写上高度。',
     'These rules were first drawn cell by cell in a notebook. Every block numbered, every edge labelled with its heights.'),
    ('sketch-2', '后来整理成 32 个块，之后我又简化到 24 个块。',
     'Later they were sorted into 32 blocks, which I then reduced to 24.'),
    ('sketch-3', '其中有一些是和地面、水面、小桥之类景观元素有关的。',
     'Some of them are landscape elements: ground, water, a small bridge.'),

    ('model-1', '建模在 Blender 里进行。用的仍然是我 2023 年手动建的。当时花了大概一整个周末。',
     'The modelling is done in Blender. The models are still the ones I built by hand in 2023, which took about a whole weekend.'),
    ('model-2', '即便现在，这种模型，也很难交给 AI 去建。因为 AI 暂时对这种多维度的目标，把握能力还比较有限。',
     'Even now such models are hard to hand over to AI, whose grasp of a target with this many dimensions is still limited.'),
    ('model-3', '不知道再过一年会是什么情况。',
     'Who knows how that will look in another year.'),

    ('collapse-1', '生成的时候，每一格先处在所有可能的叠加之中。',
     'When generating, every cell starts in a superposition of all possibilities.'),
    ('collapse-2', '可能性最少的那一格先坍缩，它的选择，又排除了邻居的一部分可能。',
     "The cell with the fewest possibilities collapses first, and its choice rules out some of its neighbours' options."),
    ('collapse-3', '一格接一格，建筑、檐廊、池塘，从局部的规则里长出来。',
     'Cell by cell, buildings, verandas and ponds grow out of local rules.'),
    ('collapse-4', '这种生成的结果是相当散漫的。因为这里面没有给出任何的评价方式。',
     'The results generated this way are rather loose, because nothing in here evaluates them.'),
    ('collapse-5', '散漫的结果，看起来就不像相对整齐的宋明官式古建，而更像日本室町时代的武家住宅格式，也称书院造（Shoin-zukuri）。',
     "Loose as they are, they look less like the fairly regular official architecture of the Song and Ming dynasties, and more like the warrior residences of Japan's Muromachi period, the style called shoin-zukuri."),

    ('play-1', '由于 vibe coding 的成熟，我最近增加了一些功能，可以手动在里面增减建筑的体量。',
     'Now that vibe coding has matured, I recently added features to add and remove building volumes by hand.'),
    ('play-2', '这种玩法和 Townscaper 大体一致。',
     'This way of playing is much the same as Townscaper.'),

    ('grid-1', '这个系统，不只能在横平竖直的网格里进行，也能放进任何，或固定或自由的四边形网格。',
     'The system does not only work on a straight, square grid; it can go into any grid of quads, fixed or free.'),
    ('grid-2', '比如 Stålberg 在他的游戏设计里用的那种。',
     'For example the kind Stålberg uses in his game design.'),
    ('grid-3', '在一个轻微扭曲的空间里，生成结果显示出貌似的有机性。',
     'In a gently bent space, the results show a seemingly organic quality.'),
    ('grid-4', '而在扭动剧烈的网格里，则显得相当现代和高技派。',
     'On a strongly twisted grid, they look quite modern, even high-tech.'),
    ('grid-5', '我从中甚至得到了一些启发，其实古建，如果放弃标准化的尺寸，其实造型上可以相当令人意外。',
     'I even took something from this: classical architecture, once it gives up standardized dimensions, can be quite surprising in form.'),

    ('ending-1', '换一套积木，就可以产生另一套风格。',
     'Swap in another set of blocks, and you get another style.'),
    ('ending-2', '多套积木的拼合，就可以形成类型学混合。',
     'Join several sets of blocks, and you get a mixture of typologies.'),
    ('ending-3', '用另一套力学来支配这种混合的方式，就会产生更高层级的秩序。',
     'Let another set of forces govern how they mix, and an order of a higher level appears.'),
    ('ending-4', '这就是这套方法的探索方向。',
     'That is the direction this method is exploring.'),
]

# long lines shown as two subtitles: where the Chinese and the English are cut
PARTS = {
    'origin-5': ('也就是', ' It is the indie game'),
    'title-3': ('——在我刚刚上手', ' who pointed me'),
    'motive-3': ('并且从我们', ' and, starting'),
    'edge-5': ('1 是檐口', ' one is the eave'),
    'edge-8': ('两个凹角', ' and two valley'),
    'model-1': ('用的仍然是', ' The models are'),
    'model-2': ('因为 AI', ' whose grasp'),
    'collapse-5': ('而更像', ' and more like'),
    'grid-1': ('也能放进', ' it can go into'),
    'grid-5': ('其实古建', ' classical architecture'),
}

entries = []
for name, chinese, english in LINES:
    entry = {'name': name, 'scene': name.split('-')[0], 'text': SPOKEN.get(name, chinese), 'zh': chinese, 'en': english}
    if name in SPOKEN:
        entry['tts'] = SPOKEN[name]
    if name in EN_FILM:
        entry['enFilm'] = EN_FILM[name]
    entry['en_spoken'] = EN_SPOKEN.get(name, english_spoken(entry.get('enFilm', english)))
    if name in PARTS:
        chinese_cut, english_cut = PARTS[name]
        chinese_position = chinese.index(chinese_cut)
        english_position = english.index(english_cut)
        entry['parts'] = [
            {'zh': chinese[:chinese_position].strip('—'), 'en': english[:english_position].strip()},
            {'zh': chinese[chinese_position:].strip('—'), 'en': english[english_position:].strip()},
        ]
    entries.append(entry)
json.dump(entries, open('narration.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(len(entries), 'lines,', sum(len(entry['text']) for entry in entries), 'characters')
