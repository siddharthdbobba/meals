#!/usr/bin/env python3
"""Generate the 200 wave-2 scout cells.

Wave 1 spent its search budget on the obvious axes: mainstream US backpacking
sites, a handful of languages, and generic trail vocabulary. Wave 2 deliberately
avoids that ground. Every cell here is either an adjacent activity, a language
wave 1 never reached, a publishing platform rather than a topic, a long-tail
dish name, a named trail, or the adaptable-outsider lane (home cooking that
survives without a fridge).
"""
import json, os, pathlib

ROOT = "/Users/sbobba/projects/meals/harvest/state"

NICHE = [
    "packrafting", "ski touring and hut trips", "splitboarding and winter camping",
    "horsepacking and mule packing", "caving and expedition underground",
    "hunting camp cooking", "ice fishing and fish camp", "trail crew and conservation corps",
    "wilderness therapy and outdoor school", "scout jamboree and troop camping",
    "summer camp kitchens", "72-hour emergency and blackout food",
    "offshore sailing galley", "RV and motorhome cooking", "overlanding and 4x4 touring",
    "festival and car-boot camping", "bothy and mountain hut cooking",
    "hammock camping", "cycle touring and randonneuring", "Camino and long-distance walking",
    "dog sledding and polar expedition", "sea kayak expedition", "canyoneering and desert trips",
    "alpine climbing bivouac", "fastpacking and trail running nutrition",
]

LANGS = [
    ("Polish", "kuchnia turystyczna, jedzenie w gorach, przepisy na biwak"),
    ("Czech", "jidlo na tury, vareni na tabore, recepty na vandr"),
    ("Russian", "еда в поход, раскладка, рецепты для похода"),
    ("Ukrainian", "їжа в похід, розкладка, рецепти похідні"),
    ("Korean", "백패킹 음식, 등산 도시락, 캠핑 요리"),
    ("Chinese", "户外 徒步 食物, 露营 菜谱, 登山 干粮"),
    ("Portuguese (Brazil)", "comida de trilha, receitas para acampamento, mochilao comida"),
    ("Italian", "cucina da trekking, ricette bivacco, cibo da rifugio"),
    ("Dutch", "eten op trektocht, kampeerrecepten, wandelvoedsel"),
    ("Finnish", "retkiruoka, eraruoka, vaellusruoka reseptit"),
    ("Swedish", "turmat recept, vandringsmat, friluftsmat"),
    ("Norwegian", "turmat oppskrifter, matpakke fjelltur, friluftsmat"),
    ("Danish", "vandremad, turmad opskrifter, friluftsmad"),
    ("Hungarian", "turakonyha, tabori fozes receptek"),
    ("Slovenian", "hrana za planinarjenje, recepti bivak"),
    ("Spanish (Spain)", "comida de senderismo, recetas de vivac, comida de montana"),
    ("Spanish (Latin America)", "comida para acampar recetas, mochilero comida"),
    ("French", "cuisine de randonnee, repas bivouac, nourriture trek"),
    ("German (deeper)", "Trekkingnahrung Rezepte, Outdoorkueche, Huettenessen"),
    ("Japanese (deeper)", "山ごはん レシピ, 登山 行動食, キャンプ飯 ブログ"),
    ("Turkish", "kamp yemekleri tarifleri, dag yemegi"),
    ("Greek", "φαγητο για καμπινγκ, συνταγες ορειβασια"),
    ("Hebrew", "אוכל לטיולים, מתכונים לשטח"),
    ("Thai", "อาหาร แคมป์ ปิ้ง สูตร, อาหาร เดินป่า"),
    ("Indonesian", "makanan pendakian, resep camping gunung"),
    ("Hindi", "trekking food recipes india, camping khana recipes"),
    ("Afrikaans", "kampkos resepte, staptog kos"),
    ("Romanian", "mancare pentru drumetii, retete camping"),
    ("Estonian / Latvian / Lithuanian", "matkatoit retseptid, pargojiems maistas"),
    ("Icelandic", "nesti a fjallgongu, utilegumatur"),
]

PLATFORMS = [
    "Substack newsletters about outdoor cooking",
    "blogspot.com era hiking blogs with recipe posts",
    "wordpress.com hosted backpacking blogs",
    "Medium posts on trail food",
    "Tumblr and LiveJournal archives of hiking food",
    "phpBB and vBulletin outdoor forums",
    "XenForo and Discourse outdoor communities",
    "Pinterest boards linking to camp recipe posts",
    "Instructables and DIY sites for camp food projects",
    "university extension service (.edu) food preservation and camp cooking guides",
    "national and state park service (.gov) camp cooking and food storage guides",
    "national trail association and hiking club sites",
    "downloadable camp cookbook PDFs",
    "archive.org and Google Books scanned camp cookbooks",
    "YouTube channels whose descriptions carry full recipes",
    "podcast show notes with trail meal recipes",
    "Strava, AllTrails, and Komoot trip write-ups mentioning food",
    "Facebook public group and page recipe posts",
    "gear cooperative and outdoor retailer international blogs",
    "outdoor magazine archives (Backpacker, TGO, Trail, Outside) recipe columns",
]

OUTSIDERS = [
    "one-pot no-fridge dinners", "pantry-only cooking with no refrigeration",
    "dorm room cooking", "hostel kitchen cooking", "boat galley cooking",
    "RV small-kitchen recipes", "off-grid and cabin cooking",
    "power outage and no-electricity meals", "camping with toddlers and kids",
    "extreme budget meals under a dollar", "shelf-stable pantry staples cooking",
    "canned food recipes", "rice cooker only recipes", "hot plate single burner meals",
    "electric kettle and hotel room cooking", "thermos cooking and thermal cooking",
    "Indian tiffin and travel food", "Japanese bento and onigiri for travel",
    "biltong, jerky, and dried meat traditions", "pemmican and historic expedition rations",
    "bannock and camp breads", "hardtack and ship's biscuit",
    "Ethiopian injera and travel-stable staples", "Tibetan tsampa and high-altitude staples",
    "chapati, paratha and roadside travel breads", "khichdi and one-pot lentil dishes",
    "instant noodle upgrades", "couscous and bulgur quick meals",
    "polenta and grits camp variations", "tortilla-based no-cook meals",
    "powdered milk, egg, and dairy substitutes cooking", "freeze-dried fruit and vegetable cooking",
    "military field ration hacks", "expedition and polar ration planning",
    "long-distance sailing provisioning", "monastic and pilgrimage travel food",
    "fire-roasted and ember cooking", "solar oven cooking",
    "wood stove and rocket stove cooking", "no-water-added meals for dry camps",
]

DISHES = [
    "cheesy bacon ramen bomb", "backcountry shepherd's pie", "dehydrated pad thai",
    "trail pizza", "camp calzone", "dutch oven cinnamon rolls", "campfire nachos",
    "hiker hash browns", "peanut noodle trail bowl", "curried lentils backpacking",
    "couscous burrito bowl", "instant refried beans meals", "jambalaya on trail",
    "backcountry mac and cheese upgrades", "salmon and rice camp dinner",
    "chorizo and potato skillet camping", "shakshuka camping", "camp congee",
    "miso soup with add-ins", "dehydrated bolognese", "trail gnocchi",
    "stuffing mix dinners", "falafel mix camp meals", "hummus trail lunch",
    "cold soak ramen", "overnight oats variations trail", "chia pudding backpacking",
    "trail mix and gorp formulas", "energy balls and bars homemade",
    "backpacking smoothie powder", "camp cocktails and trail drinks",
    "hot buttered cider camp", "backcountry brownies", "campfire apple crisp",
    "s'mores variations", "dutch oven monkey bread", "no-bake cheesecake camping",
    "breakfast burrito make-ahead camping", "hobo pie pudgy pie recipes",
    "grilled cheese on a stove", "quesadilla camping variations",
    "tuna packet recipes", "spam and canned meat camp recipes",
    "sardine and tinned fish trail lunch", "cheese and charcuterie backpacking",
]

TRAILS = [
    "Pacific Crest Trail", "Appalachian Trail", "Continental Divide Trail",
    "Colorado Trail", "John Muir Trail", "Arizona Trail", "Pacific Northwest Trail",
    "Long Trail Vermont", "Ozark Highlands Trail", "Superior Hiking Trail",
    "Boundary Waters canoe area", "Adirondack High Peaks", "White Mountains",
    "Sierra Nevada", "North Cascades", "Wind River Range",
    "Te Araroa New Zealand", "Overland Track Tasmania", "Bibbulmun Track",
    "Larapinta Trail", "Great Divide Trail Canada", "West Coast Trail",
    "Camino de Santiago", "GR20 Corsica", "Tour du Mont Blanc",
    "West Highland Way", "Cape Wrath Trail", "Pennine Way", "Coast to Coast England",
    "Kungsleden Sweden", "Laugavegur Iceland", "Lofoten Norway", "Sarek Sweden",
    "Tatra mountains", "Carpathian mountains", "Dolomites hut to hut",
    "Pyrenees HRP", "Everest Base Camp trek", "Annapurna Circuit",
    "Kilimanjaro climb", "Torres del Paine", "Patagonia trekking",
]

cells = []


def add(prefix, i, source_type, region, lexicon):
    cells.append({
        "id": f"{prefix}{i:03d}",
        "sourceType": source_type,
        "region": region,
        "lexicon": lexicon,
    })


for i, n in enumerate(NICHE):
    add("n", i, f"any site type covering {n}", "any, English first", f"{n} food and recipes")
for i, (lang, terms) in enumerate(LANGS):
    add("l", i, "blogs, forums, and clubs in this language", lang,
        f"search in {lang} using these native terms: {terms}")
for i, p in enumerate(PLATFORMS):
    add("p", i, p, "any", "camp, trail, or backpacking recipes")
for i, o in enumerate(OUTSIDERS):
    add("o", i, "any site type, including mainstream food blogs", "any",
        f"{o} — these are ADAPTABLE OUTSIDERS: general recipes that could be rewritten for trail cooking")
for i, d in enumerate(DISHES):
    add("d", i, "any site type", "any", f"the specific dish: {d}")
for i, t in enumerate(TRAILS):
    add("m", i, "trail journals, hiker blogs, forums, and association sites", "any",
        f"food, resupply, and meals specifically on the {t}")

pathlib.Path(f"{ROOT}/wave2-cells.json").write_text(json.dumps(cells, indent=1))
print(f"{len(cells)} cells written")
for p in ("n", "l", "p", "o", "d", "m"):
    print(f"  {p}: {sum(1 for c in cells if c['id'].startswith(p))}")
