# Tables

## Basic table

| Tool | Purpose |
| ---- | ------- |
| Plane | Flattening board faces |
| Chisel | Cutting joinery |

## Alignment variants

| Left aligned | Center aligned | Right aligned | Default |
| :----------- | :------------: | ------------: | ------- |
| ash | beech | cedar | dowel |
| elm | fir | gum | hazel |

## Escaped pipes inside cells

| Expression | Meaning |
| ---------- | ------- |
| `a \| b` | escaped pipe inside inline code in a cell |
| plain \| text | escaped pipe in plain cell text |
| double \|\| escape | two escaped pipes in one cell |

## Table without outer pipes

Fruit | Count
----- | ----:
apple | 3
plum | 12

## Table with inline markup in cells

| Column one | Column two |
| ---------- | ---------- |
| **bold cell text** | *italic cell text* |
| [[table-note-target]] | `code in a cell` |

## Uneven row widths

| One | Two | Three |
| --- | --- | ----- |
| short row |
| a | b | c | d | overflow cell |
