grammar Fletcher;

compilationUnit: separator* (packageClause separator+)? (importDeclaration separator+)*
    (backendClause separator+)? (declaration separator+)* (mapDeclaration | declaration)? separator* EOF;
packageClause: PACKAGE IDENTIFIER;
importDeclaration: IMPORT (importSpec | LEFT_PAREN separator* (importSpec (separator+ importSpec)* separator*)? RIGHT_PAREN);
importSpec: IDENTIFIER? stringLiteral;
backendClause: backendKeyword (CIRCUIT | SCRIPT);
backendKeyword: {CurrentToken.Text == "backend"}? IDENTIFIER;
declaration: constDeclaration | typeDeclaration | structDeclaration | interfaceDeclaration | functionDeclaration | testDeclaration | macroDeclaration;
macroDeclaration: macroKeyword IDENTIFIER LEFT_PAREN NEWLINE* parameters? RIGHT_PAREN LEFT_BRACE separator*
    (placementMember (separator+ placementMember)* separator*)? RIGHT_BRACE;
macroKeyword: {CurrentToken.Text == "macro"}? IDENTIFIER;
placementMember: placeDeclaration | macroExpansion;
macroExpansion: expandKeyword qualifiedName call;
expandKeyword: {CurrentToken.Text == "expand"}? IDENTIFIER;

mapDeclaration: MAP stringLiteral LEFT_BRACE separator* (mapMember (separator+ mapMember)* separator*)? RIGHT_BRACE;
mapMember: inputDeclaration | outputDeclaration | wireDeclaration | registerDeclaration | tickBlock | backendBlock | placementMember | screenDeclaration;
inputDeclaration: INPUT IDENTIFIER typeSyntax (AT position)?
    (WITH LEFT_BRACE NEWLINE* (optionAssignment (COMMA NEWLINE* optionAssignment)* COMMA?)? NEWLINE* RIGHT_BRACE)?;
outputDeclaration: OUTPUT IDENTIFIER typeSyntax (AT position)?
    (WITH LEFT_BRACE NEWLINE* (optionAssignment (COMMA NEWLINE* optionAssignment)* COMMA?)? NEWLINE* RIGHT_BRACE)?
    ASSIGN NEWLINE* expression;
wireDeclaration: (WIRE | PUBLISH HOST?) IDENTIFIER typeSyntax ASSIGN NEWLINE* expression;
registerDeclaration: REGISTER IDENTIFIER typeSyntax ASSIGN NEWLINE* expression;
tickBlock: HOST? TICK block;
backendBlock: (CIRCUIT | SCRIPT) LEFT_BRACE separator* (binding (separator+ binding)* separator*)? RIGHT_BRACE;
binding: outputDeclaration | wireDeclaration;
placeDeclaration: PLACE IDENTIFIER AT position (FACING IDENTIFIER)? FLIPPED?
    (WITH LEFT_BRACE NEWLINE* (optionAssignment (COMMA NEWLINE* optionAssignment)* COMMA?)? NEWLINE* RIGHT_BRACE)?;
screenDeclaration: SCREEN AT position SIZE position
    (WITH LEFT_BRACE NEWLINE* (optionAssignment (COMMA NEWLINE* optionAssignment)* COMMA?)? NEWLINE* RIGHT_BRACE)?;
optionAssignment: IDENTIFIER ASSIGN expression;
position: LEFT_PAREN expression COMMA NEWLINE* expression RIGHT_PAREN;

constDeclaration: CONST IDENTIFIER typeSyntax? ASSIGN NEWLINE* expression;
typeDeclaration: TYPE IDENTIFIER typeParameters? ASSIGN? typeSyntax;
structDeclaration: TYPE IDENTIFIER typeParameters? STRUCT LEFT_BRACE separator*
    (structField (separator+ structField)* separator*)? RIGHT_BRACE;
structField: IDENTIFIER typeSyntax;
interfaceDeclaration: TYPE IDENTIFIER typeParameters? INTERFACE LEFT_BRACE separator*
    (methodSignature (separator+ methodSignature)* separator*)? RIGHT_BRACE;
methodSignature: IDENTIFIER LEFT_PAREN NEWLINE* parameters? RIGHT_PAREN resultType?;
functionDeclaration: FUNC receiver? IDENTIFIER typeParameters? LEFT_PAREN NEWLINE* parameters? RIGHT_PAREN resultType? block;
resultType: typeSyntax | LEFT_PAREN NEWLINE* typeSyntax COMMA NEWLINE* typeSyntax
    (COMMA NEWLINE* typeSyntax)* COMMA? NEWLINE* RIGHT_PAREN;
testDeclaration: {CurrentToken.Text == "test"}? IDENTIFIER stringLiteral block;
receiver: LEFT_PAREN IDENTIFIER typeSyntax RIGHT_PAREN;
typeParameters: LESS typeParameter (COMMA NEWLINE* typeParameter)* GREATER;
typeParameter: IDENTIFIER (EXTENDS typeSyntax)?;
parameters: parameter (COMMA NEWLINE* parameter)* (COMMA NEWLINE*)?;
parameter: IDENTIFIER typeSyntax;
typeSyntax: bitsType | arrayType | namedType;
bitsType: BITS LESS constantSize GREATER;
arrayType: LEFT_BRACKET constantSize RIGHT_BRACKET typeSyntax;
namedType: qualifiedName typeArguments?;
qualifiedName: IDENTIFIER (DOT IDENTIFIER)?;
typeArguments: LESS typeSyntax (COMMA NEWLINE* typeSyntax)* GREATER;
constantSize: integerLiteral | qualifiedName;

block: LEFT_BRACE separator* (statement (separator+ statement)* separator*)? RIGHT_BRACE;
statement: block | shortVariableDeclaration | variableDeclaration | constDeclaration | assignment
    | ifStatement | switchStatement | forRangeStatement | returnStatement | nextStatement | expressionStatement;
shortVariableDeclaration: identifierList DECLARE NEWLINE* expressionList;
variableDeclaration: VAR IDENTIFIER typeSyntax? (ASSIGN NEWLINE* expression)?;
assignment: lvalue (COMMA NEWLINE* lvalue)* ASSIGN NEWLINE* expressionList;
lvalue: IDENTIFIER lvaluePart*;
lvaluePart: DOT IDENTIFIER | LEFT_BRACKET expression RIGHT_BRACKET;
ifStatement: IF expression block (ELSE (ifStatement | block))?;
switchStatement: SWITCH expression LEFT_BRACE separator* switchClause* RIGHT_BRACE;
switchClause: (CASE expressionList | DEFAULT) COLON separator* (statement (separator+ statement)* separator*)?;
forRangeStatement: FOR (IDENTIFIER (COMMA IDENTIFIER)? DECLARE)? RANGE expression block;
returnStatement: RETURN expressionList?;
nextStatement: NEXT IDENTIFIER ASSIGN NEWLINE* expression;
expressionStatement: expression;
identifierList: IDENTIFIER (COMMA NEWLINE* IDENTIFIER)*;
expressionList: expression (COMMA NEWLINE* expression)*;

expression: logicalOr;
logicalOr: logicalAnd (OR_OR NEWLINE* logicalAnd)*;
logicalAnd: comparison (AND_AND NEWLINE* comparison)*;
comparison: additive ((EQUAL_EQUAL | NOT_EQUAL | LESS | LESS_EQUAL | GREATER | GREATER_EQUAL) NEWLINE* additive)*;
additive: multiplicative ((PLUS | MINUS | PIPE | CARET) NEWLINE* multiplicative)*;
multiplicative: unary ((STAR | SLASH | PERCENT | SHIFT_LEFT | GREATER GREATER | AMP) NEWLINE* unary)*;
unary: (BANG | MINUS | PLUS | TILDE | CARET) NEWLINE* unary | postfix;
postfix: primary postfixPart*;
postfixPart: call | DOT IDENTIFIER | LEFT_BRACKET expression RIGHT_BRACKET;
call: LEFT_PAREN NEWLINE* arguments? RIGHT_PAREN;
arguments: expressionList (COMMA NEWLINE*)?;

primary: literal
    | bitsType call
    | arrayType LEFT_BRACE NEWLINE* arguments? RIGHT_BRACE
    | namedType LEFT_BRACE NEWLINE* fieldInitializers? RIGHT_BRACE
    | qualifiedName typeArguments call
    | IDENTIFIER
    | LEFT_PAREN NEWLINE* expression NEWLINE* RIGHT_PAREN;
fieldInitializers: fieldInitializer (COMMA NEWLINE* fieldInitializer)* (COMMA NEWLINE*)?;
fieldInitializer: IDENTIFIER COLON expression;
literal: integerLiteral | stringLiteral | TRUE | FALSE;
integerLiteral: INTEGER;
stringLiteral: STRING;
separator: NEWLINE | SEMICOLON;

PACKAGE: 'package';
IMPORT: 'import';
MAP: 'map';
INPUT: 'input';
OUTPUT: 'output';
WIRE: 'wire';
PUBLISH: 'publish';
HOST: 'host';
REGISTER: 'register';
TICK: 'tick';
CIRCUIT: 'circuit';
SCRIPT: 'script';
PLACE: 'place';
SCREEN: 'screen';
SIZE: 'size';
AT: 'at';
FACING: 'facing';
FLIPPED: 'flipped';
WITH: 'with';
CONST: 'const';
VAR: 'var';
TYPE: 'type';
STRUCT: 'struct';
INTERFACE: 'interface';
FUNC: 'func';
EXTENDS: 'extends';
IF: 'if';
ELSE: 'else';
SWITCH: 'switch';
CASE: 'case';
DEFAULT: 'default';
FOR: 'for';
RANGE: 'range';
RETURN: 'return';
NEXT: 'next';
BITS: 'bits';
TRUE: 'true';
FALSE: 'false';

DECLARE: ':=';
ASSIGN: '=';
EQUAL_EQUAL: '==';
NOT_EQUAL: '!=';
LESS_EQUAL: '<=';
GREATER_EQUAL: '>=';
SHIFT_LEFT: '<<';
AND_AND: '&&';
OR_OR: '||';
PLUS: '+';
MINUS: '-';
STAR: '*';
SLASH: '/';
PERCENT: '%';
BANG: '!';
TILDE: '~';
AMP: '&';
PIPE: '|';
CARET: '^';
LESS: '<';
GREATER: '>';
DOT: '.';
COMMA: ',';
COLON: ':';
SEMICOLON: ';';
LEFT_PAREN: '(';
RIGHT_PAREN: ')';
LEFT_BRACE: '{';
RIGHT_BRACE: '}';
LEFT_BRACKET: '[';
RIGHT_BRACKET: ']';

INTEGER: '0' [xX] [0-9a-fA-F] ('_'? [0-9a-fA-F])* | '0' [bB] [01] ('_'? [01])* | [0-9] ('_'? [0-9])*;
STRING: '"' (ESCAPE | ~["\\\u0000-\u001F])* '"';
fragment ESCAPE: '\\' (["\\/bfnrt] | 'u' HEX HEX HEX HEX);
fragment HEX: [0-9a-fA-F];
IDENTIFIER: [a-zA-Z_] [a-zA-Z0-9_]*;
NEWLINE: ('\r'? '\n')+;
LINE_COMMENT: '//' ~[\r\n]* -> skip;
BLOCK_COMMENT: '/*' .*? '*/' {if (Text.Contains('\n')) Type = NEWLINE; else Skip();};
WHITESPACE: [ \t]+ -> skip;
