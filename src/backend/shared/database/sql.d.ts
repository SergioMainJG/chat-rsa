// Bun imports `.sql` files as text when they are imported `with { type: 'text' }`.
declare module '*.sql' {
  const content: string;
  export default content;
}
