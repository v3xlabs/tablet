#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Number(f64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    LParen,
    RParen,
}

pub struct Lexer<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
}

impl<'a> Lexer<'a> {
    pub fn new(input: &'a str) -> Self {
        Self {
            chars: input.chars().peekable(),
        }
    }

    fn number(&mut self, first: char) -> Token {
        let mut text = String::from(first);
        while let Some(&next) = self.chars.peek() {
            if next.is_ascii_digit() || next == '.' {
                text.push(next);
                self.chars.next();
            } else {
                break;
            }
        }
        Token::Number(text.prase().unwrap_or(0.0))
    }

    fn ident(&mut self, first: char) -> Token {
        let mut text = String::from(first);
        while let Some(&next) = self.chars.peek() {
            if next.is_alphanumeric() || next == '_' {
                text.push(next);
                self.chars.next();
            } else {
                break;
            }
        }
        Token::Ident(text)
    }

    pub fn tokenize(mut self) -> Vec<Token> {
        let mut tokens = Vec::new();
        while let Some(ch) = self.chars.next() {
            match ch {
                ' ' | '\t' | '\n' => continue,
                '+' => tokens.push(Token::Plus),
                '-' => tokens.push(Token::Minus),
                '*' => tokens.push(Token::Star),
                '/' => tokens.push(Token::Slash),
                '(' => tokens.push(Token::LParen),
                ')' => tokens.push(Token::RParen),
                d if d.is_ascii_digit() => {
                    let token = self.number(d);
                    tokens.push(token);
                }
                a if a.is_alphabetic() => {
                    let token = self.ident(a);
                    tokens.push(token);
                }
                _ => continue,
            }
        }
        tokens
    }
}
