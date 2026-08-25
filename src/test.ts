// TODO: there are a few mistakes in this file
const a = 5;
const b = 10;
const c = a + b;
const myLoggingFunction = (message: string) => console.log(message);

const hello = () => {
  const x = "world";

  myLoggingFunction(`The value of c is ${c}`);

  const y = "world";

  console.log(`Hello ${x}!`);
};
