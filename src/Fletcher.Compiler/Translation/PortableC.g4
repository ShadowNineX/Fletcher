grammar PortableC;

translationUnit: functionDeclaration* EOF;
functionDeclaration: STATIC? (integerType | VOID) Identifier '(' (VOID | parameter (',' parameter)*)? ')' (block | ';');
parameter: CONST? integerType Identifier?;
integerType: INT | (SIGNED | UNSIGNED) INT?;

block: '{' statement* '}';
statement
    : block                                                         # nestedBlock
    | CONST? integerType local (',' local)* ';'                      # localDeclaration
    | update ';'                                                    # updateStatement
    | IF '(' expression ')' statement (ELSE statement)?              # conditional
    | FOR '(' INT index=Identifier '=' start=Integer ';' cursor=Identifier '<' bound=(Identifier | Integer) ';' increment ')' statement
                                                                    # countedLoop
    | RETURN expression? ';'                                        # returnStatement
    | call ';'                                                      # callStatement
    | ';'                                                           # emptyStatement
    ;
local: Identifier ('[' Integer ']')? ('=' (expression | initializer))?;
initializer: '{' (expression (',' expression)* ','?)? '}';
update: lvalue op=('=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=') expression | increment;
increment: Identifier op=('++' | '--') | op=('++' | '--') Identifier;
lvalue: Identifier ('[' expression ']')?;
call: Identifier '(' (expression (',' expression)*)? ')';
expression
    : '(' expression ')'                                            # grouped
    | '(' integerType ')' expression                                # cast
    | op=('+' | '-' | '!' | '~') expression                           # unary
    | Integer                                                       # integer
    | call                                                          # invocation
    | lvalue                                                        # readValue
    | expression op=('*' | '/' | '%') expression                     # binary
    | expression op=('+' | '-') expression                           # binary
    | expression op=('<<' | '>>') expression                         # binary
    | expression op=('<' | '<=' | '>' | '>=') expression                # binary
    | expression op=('==' | '!=') expression                         # binary
    | expression op='&' expression                                   # binary
    | expression op='^' expression                                   # binary
    | expression op='|' expression                                   # binary
    | expression op='&&' expression                                  # binary
    | expression op='||' expression                                  # binary
    ;

STATIC: 'static';
CONST: 'const';
VOID: 'void';
INT: 'int';
SIGNED: 'signed';
UNSIGNED: 'unsigned';
IF: 'if';
ELSE: 'else';
FOR: 'for';
RETURN: 'return';
Identifier: [a-zA-Z_] [a-zA-Z0-9_]*;
Integer: ('0' [xX] [0-9a-fA-F]+ | '0' [0-7]* | [1-9] [0-9]*) [uU]?;
LineComment: '//' ~[\r\n]* -> skip;
BlockComment: '/*' .*? '*/' -> skip;
Whitespace: [ \t\r\n\f]+ -> skip;
