/** Invalidates asynchronous content reads when a newer navigation starts. */
export class ContentRequestGate {
  private generation = 0;

  next(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}
