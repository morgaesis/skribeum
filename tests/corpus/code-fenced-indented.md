# Code blocks

## Fenced with info string

```rust
fn corpus_marker() -> u32 {
    42
}
```

## Fenced without info string

```
plain fenced text with no language
second line of the plain fence
```

## Fenced with tildes and info string

~~~python
def corpus_marker():
    return 42
~~~

## Fenced with tildes and no info string

~~~
tilde fence without a language tag
~~~

## Fence containing backticks

````text
A fence made of four backticks can contain ``` three backticks.
````

## Info string with extra fields

```js {line=3 title="sample"}
const markerValue = 42;
```

## Indented code block

    indented code line one
    indented code line two
        deeper indented line inside the block

## Indented code after a paragraph requires a blank line

This paragraph precedes the indented block.

    another indented code block
    with two lines

## Inline code

A sentence with `inline code`, with `code containing *asterisks*`, and with
``inline code containing a ` backtick`` inside double backticks.

## Unclosed constructs stay in their block

```text
This fence closes normally.
```
