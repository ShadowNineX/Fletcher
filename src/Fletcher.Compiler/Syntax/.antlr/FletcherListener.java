// Generated from c:/Coding/Fletcher/src/Fletcher.Compiler/Syntax/Fletcher.g4 by ANTLR 4.13.1
import org.antlr.v4.runtime.tree.ParseTreeListener;

/**
 * This interface defines a complete listener for a parse tree produced by
 * {@link FletcherParser}.
 */
public interface FletcherListener extends ParseTreeListener {
	/**
	 * Enter a parse tree produced by {@link FletcherParser#compilationUnit}.
	 * @param ctx the parse tree
	 */
	void enterCompilationUnit(FletcherParser.CompilationUnitContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#compilationUnit}.
	 * @param ctx the parse tree
	 */
	void exitCompilationUnit(FletcherParser.CompilationUnitContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#packageClause}.
	 * @param ctx the parse tree
	 */
	void enterPackageClause(FletcherParser.PackageClauseContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#packageClause}.
	 * @param ctx the parse tree
	 */
	void exitPackageClause(FletcherParser.PackageClauseContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#importDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterImportDeclaration(FletcherParser.ImportDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#importDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitImportDeclaration(FletcherParser.ImportDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#importSpec}.
	 * @param ctx the parse tree
	 */
	void enterImportSpec(FletcherParser.ImportSpecContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#importSpec}.
	 * @param ctx the parse tree
	 */
	void exitImportSpec(FletcherParser.ImportSpecContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#declaration}.
	 * @param ctx the parse tree
	 */
	void enterDeclaration(FletcherParser.DeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#declaration}.
	 * @param ctx the parse tree
	 */
	void exitDeclaration(FletcherParser.DeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#mapDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterMapDeclaration(FletcherParser.MapDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#mapDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitMapDeclaration(FletcherParser.MapDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#mapMember}.
	 * @param ctx the parse tree
	 */
	void enterMapMember(FletcherParser.MapMemberContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#mapMember}.
	 * @param ctx the parse tree
	 */
	void exitMapMember(FletcherParser.MapMemberContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#inputDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterInputDeclaration(FletcherParser.InputDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#inputDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitInputDeclaration(FletcherParser.InputDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#outputDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterOutputDeclaration(FletcherParser.OutputDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#outputDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitOutputDeclaration(FletcherParser.OutputDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#wireDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterWireDeclaration(FletcherParser.WireDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#wireDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitWireDeclaration(FletcherParser.WireDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#registerDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterRegisterDeclaration(FletcherParser.RegisterDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#registerDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitRegisterDeclaration(FletcherParser.RegisterDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#tickBlock}.
	 * @param ctx the parse tree
	 */
	void enterTickBlock(FletcherParser.TickBlockContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#tickBlock}.
	 * @param ctx the parse tree
	 */
	void exitTickBlock(FletcherParser.TickBlockContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#backendBlock}.
	 * @param ctx the parse tree
	 */
	void enterBackendBlock(FletcherParser.BackendBlockContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#backendBlock}.
	 * @param ctx the parse tree
	 */
	void exitBackendBlock(FletcherParser.BackendBlockContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#binding}.
	 * @param ctx the parse tree
	 */
	void enterBinding(FletcherParser.BindingContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#binding}.
	 * @param ctx the parse tree
	 */
	void exitBinding(FletcherParser.BindingContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#placeDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterPlaceDeclaration(FletcherParser.PlaceDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#placeDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitPlaceDeclaration(FletcherParser.PlaceDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#screenDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterScreenDeclaration(FletcherParser.ScreenDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#screenDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitScreenDeclaration(FletcherParser.ScreenDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#optionAssignment}.
	 * @param ctx the parse tree
	 */
	void enterOptionAssignment(FletcherParser.OptionAssignmentContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#optionAssignment}.
	 * @param ctx the parse tree
	 */
	void exitOptionAssignment(FletcherParser.OptionAssignmentContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#position}.
	 * @param ctx the parse tree
	 */
	void enterPosition(FletcherParser.PositionContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#position}.
	 * @param ctx the parse tree
	 */
	void exitPosition(FletcherParser.PositionContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#constDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterConstDeclaration(FletcherParser.ConstDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#constDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitConstDeclaration(FletcherParser.ConstDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#typeDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterTypeDeclaration(FletcherParser.TypeDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#typeDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitTypeDeclaration(FletcherParser.TypeDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#structDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterStructDeclaration(FletcherParser.StructDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#structDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitStructDeclaration(FletcherParser.StructDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#structField}.
	 * @param ctx the parse tree
	 */
	void enterStructField(FletcherParser.StructFieldContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#structField}.
	 * @param ctx the parse tree
	 */
	void exitStructField(FletcherParser.StructFieldContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#interfaceDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterInterfaceDeclaration(FletcherParser.InterfaceDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#interfaceDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitInterfaceDeclaration(FletcherParser.InterfaceDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#methodSignature}.
	 * @param ctx the parse tree
	 */
	void enterMethodSignature(FletcherParser.MethodSignatureContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#methodSignature}.
	 * @param ctx the parse tree
	 */
	void exitMethodSignature(FletcherParser.MethodSignatureContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#functionDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterFunctionDeclaration(FletcherParser.FunctionDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#functionDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitFunctionDeclaration(FletcherParser.FunctionDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#receiver}.
	 * @param ctx the parse tree
	 */
	void enterReceiver(FletcherParser.ReceiverContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#receiver}.
	 * @param ctx the parse tree
	 */
	void exitReceiver(FletcherParser.ReceiverContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#typeParameters}.
	 * @param ctx the parse tree
	 */
	void enterTypeParameters(FletcherParser.TypeParametersContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#typeParameters}.
	 * @param ctx the parse tree
	 */
	void exitTypeParameters(FletcherParser.TypeParametersContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#typeParameter}.
	 * @param ctx the parse tree
	 */
	void enterTypeParameter(FletcherParser.TypeParameterContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#typeParameter}.
	 * @param ctx the parse tree
	 */
	void exitTypeParameter(FletcherParser.TypeParameterContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#parameters}.
	 * @param ctx the parse tree
	 */
	void enterParameters(FletcherParser.ParametersContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#parameters}.
	 * @param ctx the parse tree
	 */
	void exitParameters(FletcherParser.ParametersContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#parameter}.
	 * @param ctx the parse tree
	 */
	void enterParameter(FletcherParser.ParameterContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#parameter}.
	 * @param ctx the parse tree
	 */
	void exitParameter(FletcherParser.ParameterContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#typeSyntax}.
	 * @param ctx the parse tree
	 */
	void enterTypeSyntax(FletcherParser.TypeSyntaxContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#typeSyntax}.
	 * @param ctx the parse tree
	 */
	void exitTypeSyntax(FletcherParser.TypeSyntaxContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#bitsType}.
	 * @param ctx the parse tree
	 */
	void enterBitsType(FletcherParser.BitsTypeContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#bitsType}.
	 * @param ctx the parse tree
	 */
	void exitBitsType(FletcherParser.BitsTypeContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#arrayType}.
	 * @param ctx the parse tree
	 */
	void enterArrayType(FletcherParser.ArrayTypeContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#arrayType}.
	 * @param ctx the parse tree
	 */
	void exitArrayType(FletcherParser.ArrayTypeContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#namedType}.
	 * @param ctx the parse tree
	 */
	void enterNamedType(FletcherParser.NamedTypeContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#namedType}.
	 * @param ctx the parse tree
	 */
	void exitNamedType(FletcherParser.NamedTypeContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#qualifiedName}.
	 * @param ctx the parse tree
	 */
	void enterQualifiedName(FletcherParser.QualifiedNameContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#qualifiedName}.
	 * @param ctx the parse tree
	 */
	void exitQualifiedName(FletcherParser.QualifiedNameContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#typeArguments}.
	 * @param ctx the parse tree
	 */
	void enterTypeArguments(FletcherParser.TypeArgumentsContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#typeArguments}.
	 * @param ctx the parse tree
	 */
	void exitTypeArguments(FletcherParser.TypeArgumentsContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#constantSize}.
	 * @param ctx the parse tree
	 */
	void enterConstantSize(FletcherParser.ConstantSizeContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#constantSize}.
	 * @param ctx the parse tree
	 */
	void exitConstantSize(FletcherParser.ConstantSizeContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#block}.
	 * @param ctx the parse tree
	 */
	void enterBlock(FletcherParser.BlockContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#block}.
	 * @param ctx the parse tree
	 */
	void exitBlock(FletcherParser.BlockContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#statement}.
	 * @param ctx the parse tree
	 */
	void enterStatement(FletcherParser.StatementContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#statement}.
	 * @param ctx the parse tree
	 */
	void exitStatement(FletcherParser.StatementContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#shortVariableDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterShortVariableDeclaration(FletcherParser.ShortVariableDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#shortVariableDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitShortVariableDeclaration(FletcherParser.ShortVariableDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#variableDeclaration}.
	 * @param ctx the parse tree
	 */
	void enterVariableDeclaration(FletcherParser.VariableDeclarationContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#variableDeclaration}.
	 * @param ctx the parse tree
	 */
	void exitVariableDeclaration(FletcherParser.VariableDeclarationContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#assignment}.
	 * @param ctx the parse tree
	 */
	void enterAssignment(FletcherParser.AssignmentContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#assignment}.
	 * @param ctx the parse tree
	 */
	void exitAssignment(FletcherParser.AssignmentContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#lvalue}.
	 * @param ctx the parse tree
	 */
	void enterLvalue(FletcherParser.LvalueContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#lvalue}.
	 * @param ctx the parse tree
	 */
	void exitLvalue(FletcherParser.LvalueContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#lvaluePart}.
	 * @param ctx the parse tree
	 */
	void enterLvaluePart(FletcherParser.LvaluePartContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#lvaluePart}.
	 * @param ctx the parse tree
	 */
	void exitLvaluePart(FletcherParser.LvaluePartContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#ifStatement}.
	 * @param ctx the parse tree
	 */
	void enterIfStatement(FletcherParser.IfStatementContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#ifStatement}.
	 * @param ctx the parse tree
	 */
	void exitIfStatement(FletcherParser.IfStatementContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#forRangeStatement}.
	 * @param ctx the parse tree
	 */
	void enterForRangeStatement(FletcherParser.ForRangeStatementContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#forRangeStatement}.
	 * @param ctx the parse tree
	 */
	void exitForRangeStatement(FletcherParser.ForRangeStatementContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#returnStatement}.
	 * @param ctx the parse tree
	 */
	void enterReturnStatement(FletcherParser.ReturnStatementContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#returnStatement}.
	 * @param ctx the parse tree
	 */
	void exitReturnStatement(FletcherParser.ReturnStatementContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#nextStatement}.
	 * @param ctx the parse tree
	 */
	void enterNextStatement(FletcherParser.NextStatementContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#nextStatement}.
	 * @param ctx the parse tree
	 */
	void exitNextStatement(FletcherParser.NextStatementContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#expressionStatement}.
	 * @param ctx the parse tree
	 */
	void enterExpressionStatement(FletcherParser.ExpressionStatementContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#expressionStatement}.
	 * @param ctx the parse tree
	 */
	void exitExpressionStatement(FletcherParser.ExpressionStatementContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#identifierList}.
	 * @param ctx the parse tree
	 */
	void enterIdentifierList(FletcherParser.IdentifierListContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#identifierList}.
	 * @param ctx the parse tree
	 */
	void exitIdentifierList(FletcherParser.IdentifierListContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#expressionList}.
	 * @param ctx the parse tree
	 */
	void enterExpressionList(FletcherParser.ExpressionListContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#expressionList}.
	 * @param ctx the parse tree
	 */
	void exitExpressionList(FletcherParser.ExpressionListContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#expression}.
	 * @param ctx the parse tree
	 */
	void enterExpression(FletcherParser.ExpressionContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#expression}.
	 * @param ctx the parse tree
	 */
	void exitExpression(FletcherParser.ExpressionContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#logicalOr}.
	 * @param ctx the parse tree
	 */
	void enterLogicalOr(FletcherParser.LogicalOrContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#logicalOr}.
	 * @param ctx the parse tree
	 */
	void exitLogicalOr(FletcherParser.LogicalOrContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#logicalAnd}.
	 * @param ctx the parse tree
	 */
	void enterLogicalAnd(FletcherParser.LogicalAndContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#logicalAnd}.
	 * @param ctx the parse tree
	 */
	void exitLogicalAnd(FletcherParser.LogicalAndContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#comparison}.
	 * @param ctx the parse tree
	 */
	void enterComparison(FletcherParser.ComparisonContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#comparison}.
	 * @param ctx the parse tree
	 */
	void exitComparison(FletcherParser.ComparisonContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#additive}.
	 * @param ctx the parse tree
	 */
	void enterAdditive(FletcherParser.AdditiveContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#additive}.
	 * @param ctx the parse tree
	 */
	void exitAdditive(FletcherParser.AdditiveContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#multiplicative}.
	 * @param ctx the parse tree
	 */
	void enterMultiplicative(FletcherParser.MultiplicativeContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#multiplicative}.
	 * @param ctx the parse tree
	 */
	void exitMultiplicative(FletcherParser.MultiplicativeContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#unary}.
	 * @param ctx the parse tree
	 */
	void enterUnary(FletcherParser.UnaryContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#unary}.
	 * @param ctx the parse tree
	 */
	void exitUnary(FletcherParser.UnaryContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#postfix}.
	 * @param ctx the parse tree
	 */
	void enterPostfix(FletcherParser.PostfixContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#postfix}.
	 * @param ctx the parse tree
	 */
	void exitPostfix(FletcherParser.PostfixContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#postfixPart}.
	 * @param ctx the parse tree
	 */
	void enterPostfixPart(FletcherParser.PostfixPartContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#postfixPart}.
	 * @param ctx the parse tree
	 */
	void exitPostfixPart(FletcherParser.PostfixPartContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#call}.
	 * @param ctx the parse tree
	 */
	void enterCall(FletcherParser.CallContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#call}.
	 * @param ctx the parse tree
	 */
	void exitCall(FletcherParser.CallContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#arguments}.
	 * @param ctx the parse tree
	 */
	void enterArguments(FletcherParser.ArgumentsContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#arguments}.
	 * @param ctx the parse tree
	 */
	void exitArguments(FletcherParser.ArgumentsContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#primary}.
	 * @param ctx the parse tree
	 */
	void enterPrimary(FletcherParser.PrimaryContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#primary}.
	 * @param ctx the parse tree
	 */
	void exitPrimary(FletcherParser.PrimaryContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#fieldInitializers}.
	 * @param ctx the parse tree
	 */
	void enterFieldInitializers(FletcherParser.FieldInitializersContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#fieldInitializers}.
	 * @param ctx the parse tree
	 */
	void exitFieldInitializers(FletcherParser.FieldInitializersContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#fieldInitializer}.
	 * @param ctx the parse tree
	 */
	void enterFieldInitializer(FletcherParser.FieldInitializerContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#fieldInitializer}.
	 * @param ctx the parse tree
	 */
	void exitFieldInitializer(FletcherParser.FieldInitializerContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#literal}.
	 * @param ctx the parse tree
	 */
	void enterLiteral(FletcherParser.LiteralContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#literal}.
	 * @param ctx the parse tree
	 */
	void exitLiteral(FletcherParser.LiteralContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#integerLiteral}.
	 * @param ctx the parse tree
	 */
	void enterIntegerLiteral(FletcherParser.IntegerLiteralContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#integerLiteral}.
	 * @param ctx the parse tree
	 */
	void exitIntegerLiteral(FletcherParser.IntegerLiteralContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#stringLiteral}.
	 * @param ctx the parse tree
	 */
	void enterStringLiteral(FletcherParser.StringLiteralContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#stringLiteral}.
	 * @param ctx the parse tree
	 */
	void exitStringLiteral(FletcherParser.StringLiteralContext ctx);
	/**
	 * Enter a parse tree produced by {@link FletcherParser#separator}.
	 * @param ctx the parse tree
	 */
	void enterSeparator(FletcherParser.SeparatorContext ctx);
	/**
	 * Exit a parse tree produced by {@link FletcherParser#separator}.
	 * @param ctx the parse tree
	 */
	void exitSeparator(FletcherParser.SeparatorContext ctx);
}