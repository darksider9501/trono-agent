# Defiende el Trono — mapa de apartados

Verificado en vivo el 2026-11-11 con `scripts/trono/explore.js` (47 secciones, `state/sections.json` + HTML crudo en `state/sections/`).

Legenda de rol:
- **AUTO** — el runner ya lo ejecuta sin intervención.
- **READ** — el runner lo lee para decidir (no escribe).
- **FUTURO** — mapeado, bloqueado por nivel, oro o materiales.
- **HUMANO** — requiere tu decisión (dinero real).

---

## 1. PERSONAJE

| Apartado | URL | Datos clave | API | Rol |
|---|---|---|---|---|
| Resumen | `/pages/overview.php` | stats, puntos de atributo, equipo | `POST /api/hero_attributes.php` `{attribute}` | **AUTO** |
| Reclutar | `/pages/heroes.php` | héroes disponibles | — | FUTURO |
| Inventario | `/pages/inventory.php` | 12 slots, `hero-equipment` root | `POST /api/hero_equipment.php` `{action:'equip', item_instance_id, slot, request_id}` | **AUTO** (equipa mejoras) |
| Misiones | `/pages/quests_main.php` | campaña, diarias, semanales, especiales | ver §9 | **AUTO** |

**Atributos** (verificado): 1 punto por llamada, 3 por nivel. VITALIDAD +10 HP +1 def (afinidad de clase), FUERZA +2 atk +2 dmg.
Política del bot: elige la que maximiza EXP/HP con el predictor de `lib/combat.js`, no una regla fija.

---

## 2. MUNDO

| Apartado | URL | Datos clave | Rol |
|---|---|---|---|
| Mapa Mundial | `/pages/map.php` | regiones `data-region-id` (1 Sylvenor, 535 práctica), encuentros en `#sylvenorEncounterLayer` | **AUTO** (fuente de objetivos) |
| Mazmorras | `/pages/dungeon.php` | 5 mazmorras, **NV 20/30/40/50/60**, 6–10 estamina, 1–4 jugadores | FUTURO |
| Jefes Mundiales | `/pages/bosses.php` | rotación global, `data-active-boss`; Nerazhul 11/11 19:00 | FUTURO (evento) |
| Arena PvP | `/pages/arena.php` | duelos 1v1, arena en grupo 2v2/3v3/4v4, Gloria | FUTURO |

**Combate (núcleo del bot).** `GET /pages/combat_pve.php?location_id=&world_enemy_id=`, luego JSON en `/api/combat_pve.php`:
`create_from_world` → `attack` / `skill` → `recover_abandon`.
Modelo de daño medido: básico `atk - def`, habilidad `round(atk*power) - def`, quemadura `round(0.26*round(atk*power))` 3 turnos, recibido `dmg_enemigo - armadura` (x2 si la diferencia de nivel ≥ 5).
Tarjetas región 1: virex 2/160/20/4 · aeril 3/255/26/6 · brumak 4/332/33/8 · lyss 5/491/39/10 · morvak 6/625/46/12 · eryndor 7/774/52/14 · nymira 8/952/59/16 · sylthar 10/1637/110/20.
**Mejor farmeo actual: Virex — 160 EXP por ~66 HP (2,42 EXP/HP).**

---

## 3. PODER

| Apartado | URL | Datos clave | API | Rol |
|---|---|---|---|---|
| Habilidades | `/pages/skills.php` | 11 poderes, 1 punto/nivel, rango 0–10 | `POST /api/hero_skill_upgrade.php` `{skill_key}` | **AUTO** |
| Árbol de Talentos | `/pages/talents.php` | 3 ramas (ofensiva/defensiva/utilidad), **2 puntos libres ya** | `POST /actions/talent_tree_use.php` `{csrf, hero:'inferno', talent_key}` | **AUTO** (nuevo) |
| Runas | `/pages/runes.php` | engarzar/extraer/fusionar; piezas comunes = 1 ranura nivel 1 | `GET /api/runes.php` | FUTURO |

Habilidad aprendida: **Rayo de Fuego Salvaje NV.1** (125%, 7 maná, CD 2, quemadura 26% ×3). Fue la diferencia entre perder contra Aeril (−316 HP) y ganar (−170 HP).

Talentos disponibles en NV 1 (raíz de cada rama, 0/5): `inferno_offense_root` +0,5% daño · `inferno_defense_root` +0,5% defensa · `inferno_utility_root` +0,5% regen maná. Las ramas secundarias piden NV 5 o completar la raíz 5/5.

---

## 4. EDIFICIOS (lo que pediste a fondo)

Todas las vistas comparten URL `GET /pages/buildings.php?view=<clave>`; el POST de mejora es el mismo formulario
`building_key=<clave>` (+`csrf`), y el de descanso añade `action=rest`.

| Edificio | Clave | Efecto por nivel | Estado | Requisitos siguiente nivel |
|---|---|---|---|---|
| **Herrería** | `smithy` | forja equipo hasta +N y **fabrica pociones** | NV 1 | 20 Lingote de Acero de Arken · 15 Piedra de Khar-Dum · 5 Cuero Curtido · 300 oro · **24 h** |
| **Santuario de Resistencia** | `rest_camp` | estamina máx +5/5/7/8/9/10… y **+0,2 estamina/h al descansar** por nivel | NV 1 | (materiales) |
| **Torre Arcana** | `arcane_tower` | regeneración de maná 1,5%/min pasiva, +0,5 pp por nivel; 2% descansando | NV 1 | Cristal … |
| **Hospital** | `hospital` | regeneración de vida 1,5%/min pasiva, **+0,5%/min por nivel** descansando | NV 1 | materiales |
| **Establo** | `stable` | +0,25% a estadísticas de mascotas por nivel | NV 1 | 22 Madera de Sylvenor · 10 Cuero Curtido · 8 Piedra de Khar-Dum · 300 oro |
| Fortaleza | `fortress` | — | NV 0 (no construido) | bloqueado |
| Mina de Oro | `gold_mine` | producción de oro diaria | NV 0 | bloqueado |
| Santuario de Maná | `mana_sanctum` | — | NV 0 | bloqueado |
| Pozo de Esencia | `essence_well` | — | NV 0 | bloqueado |
| Cámara de Reliquias | `relic_vault` | — | NV 0 | bloqueado |
| Taller | `workshop` | refinado de materiales | NV 0 | bloqueado |
| Murallas | `walls` | — | NV 0 | bloqueado |

**Lo importante para rentabilidad:** los edificios no construidos devuelven la Herrería si se piden por URL
(no existen todavía: `levels` en `player_state` los muestra en 0). El cuello de botella de **todos** es el mismo:
**materiales** (Madera de Sylvenor, Cuero Curtido, Piedra de Khar-Dum, Lingote de Acero de Arken, Cristal…),
que hoy están en 0 y solo salen de botín de combate o del mercado de jugadores.
El oro ya alcanza para varias mejoras (481 ≥ 300); lo que falta son materiales.

**Alquimia en Herrería** (`POST /pages/buildings.php` form `building_key=smithy&action=craft&recipe_id&csrf`):
Poción de Vida Menor = **250 oro + 2 Carne de Bestia + 4 Madera de Sylvenor** → cura 15% del HP máximo al instante.
Alternativa en tienda: **13 gemas** (`/pages/consumables.php`, `data-price="13"`). Sin gemas hoy.
→ Con la regeneración actual (~6,3 HP/min) una poción de 47 HP vale ~7,5 min de espera. Compra materiales solo si el precio
en el mercado de jugadores es menor que ese tiempo ahorrado.

---

## 5. REINO

| Apartado | URL | Datos clave | Rol |
|---|---|---|---|
| Mi reino | `/pages/kingdoms.php` | fundar/unirse, niveles | READ |
| Militar | `data-api="/api/reino_military.php"` | ejército del reino | FUTURO |
| Producción diaria | `/api/daily_production.php` | `total_per_day` 164,5 oro/día, ciclo 24 h, tope 30 h | **AUTO** (reclama) |

---

## 6. MERCADO

| Apartado | URL | Datos clave | Rol |
|---|---|---|---|
| Tienda Oficial | `/pages/market.php` | equipo por oro/gemas | FUTURO |
| Alquimia Real | `/pages/consumables.php` | 27 consumibles; pociones por **gemas** (13 = vida menor) | FUTURO (0 gemas) |
| Mercado de Jugadores | `/pages/player_market.php` | **104 materiales en venta**, impuesto 5% al vendedor, +VENDER MATERIAL | **Oportunidad clave** |
| Subastas | `/pages/auctions.php` | `api/auction_snapshot.php`, `auction_bid.php`, `auction_stream.php` | FUTURO |
| Mascotas | `/pages/shop.php?section=pets` | invocar/fortalecer; el Establo las potencia | FUTURO |

El mercado de jugadores es lo que desbloquea edificios y pociones: se puede **vender** botín redundante y **comprar**
materiales. Todavía no hay precios leídos ni oro asignado: falta la política de compra (ver §12).

---

## 7. ECONOMÍA (dinero real)

| Apartado | URL | Datos clave | Rol |
|---|---|---|---|
| Mi billetera | `/pages/wallet.php` | USDT BEP20/TRC20, `api/game_wallet.php` | **HUMANO** |
| Casa de Cambio | `/pages/economy.php` | 2.000 oro = 19 diamantes · **10.000 oro = 1 DOTIRIA** · 5% comisión | FUTURO |
| Retiros | `/pages/economy.php?section=withdrawals` | `api/crypto_withdrawal.php`; **cupo 15 USDT**, primer retiro 10–15 USDT sin depósito, luego depósito +30% | **HUMANO** |

Cadena completa: oro → DOTIRIA (10.000:1) → USDT (mínimo 10 = **100.000 oro**) → wallet externa.
El bot nunca toca esta sección: cualquier operación con dinero real requiere tu aprobación explícita.

---

## 8. COMUNIDAD / EVENTOS / CUENTA

| Apartado | URL | Rol |
|---|---|---|
| Streamers · Amigos · Grupos · Chat · Ranking | `/pages/{streamers,friends,groups,messages,ranking}.php` | READ (social, sin valor directo) |
| Eventos · Calendario · Temporadas | `/pages/events*.php` | READ (los jefes mundiales son eventos con hora) |
| Perfil · Referidos · Soporte · Noticias · Feedback | `/pages/{profile,referrals,support,news,feedback}.php` | READ |

Los referidos y el bono del 30% de depósito son la única vía de acelerar el cupo de retiro; el bot no los usa
sin decisión tuya.

---

## 9. MISIONES (la mejor fuente de ingreso sin coste de HP)

`GET /pages/quests_main.php` · ofertas en `?view=ofertas`.

**Flujo verificado:** las tarjetas de oferta vienen como `<template data-mission-selection="<id>">`; aceptar es
`POST /pages/quests_main.php?view=ofertas` con `quest_action=accept_offer&instance_id=<id>&csrf=<16 hex>`.
**El progreso solo cuenta después de aceptar.** Reclamar: `?cat=diarias&estado=ready`.

Cada diaria reclamada = **20 puntos de actividad**; los tramos 20/40/60/80/100 pagan 15/15/20/20/30 oro + 25 EXP.
Reinicio 09:00. Campaña y semanales no suman actividad.

Diarias aceptadas hoy (4): Patrulla diaria (15 criaturas Sylvenor, 27 oro + 200 EXP) · Protege los caminos
(20 criaturas, 30 oro + 250 EXP) · Suministros del día (10 materiales, 24 oro + 150 EXP) · Tesoros del camino
(1 cofre, 21 oro + 150 EXP). Se descartó Preparativos de alquimia (fabrica 2 pociones: exige gastar oro).

---

## 10. Scripts del agente

| Script | Qué hace |
|---|---|
| `runner.js` | bucle autónomo: heartbeat → reclamos gratis → diarias → puntos → mejor pelea → descanso. Lock de driver único. |
| `plan.js` | ranking de objetivos (WIN/LOSE, HP, EXP/HP, EXP/estamina) |
| `explore.js` | mapea secciones a JSON + HTML crudo |
| `report.js` | informe legible sobre `sections.json` |
| `dailies.js` | tablón de diarias |
| `lib/combat.js` · `lib/dailies.js` · `lib/talents.js` | motores |
| `lib/driverlock.js` | impide dos drivers sobre la misma pestaña |

---

## 11. Regla de oro del sistema

**Solo un proceso puede manejar la pestaña.** El servidor rota la instancia de sesión en cada ping de actividad:
dos drivers se invalidan mutuamente, la pestaña se va al lobby y todo `Runtime.evaluate` en vuelo muere con
`Inspected target navigated`. Por eso `runner.js` toma `logs/driver.lock` y `explore.js` se niega a correr si está ocupado.

## 12. Pendiente de decisión tuya

1. **Comprar materiales** en el mercado de jugadores con oro (hoy 481) para desbloquear pociones y mejoras de edificio.
   Propuesta: límite de gasto y solo materiales con retorno claro (vida → más peleas por hora).
2. **Alcance del dinero real**: el bot deja la sección Economía intacta. Si querés que prepare el retiro
   (10.000 oro → DOTIRIA → USDT) hace falta tu autorización explícita y wallet destino.
