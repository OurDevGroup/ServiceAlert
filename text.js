var x = "5/9/17 3:38:50 pm US/Central";
var t = x.match(/(\d+\/\d+\/\d+.\d+:\d+:\d+.(am|pm))/i);
var z = t[0].trim().toString();
console.log(new Date(z));
console.log(z);
console.log(z == '5/9/17 3:38:50 pm');
console.log(new Date('5/9/17 3:38:50 pm'));

var combining = /[\u0300-\u036F]/g;

console.log(new Date(z.normalize('NFKD').replace(combining, '')));