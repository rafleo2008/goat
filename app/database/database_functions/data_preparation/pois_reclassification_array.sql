------------------------------------------------
----- Pois reclassification array function------
-- Look for elements that is any list value in the old_col and then tag it a  "new_name" in "new_col"
-- Input values
-- 	old_col	: Column to look up
--	old name: Values to look, in this case correspond to a name in the variable container -> pois_search_conditions.
-- 	new_col	: Column to be modified with the new name
-- 	new name: Value to put in the new column
-- 	restriction: Lookup values, left means fixed to the left (begining to the text) , rigth: fixed to the rigth (end of text), anything else, any position

CREATE OR REPLACE FUNCTION pois_reclassification_array(old_col TEXT, old_name TEXT, new_col TEXT, new_name TEXT, restriction text )
	RETURNS SETOF void
	LANGUAGE plpgsql
AS $function$
DECLARE 
	pois_conditions TEXT[];
BEGIN
	EXECUTE 'UPDATE pois 
	SET '|| quote_ident(new_col) ||' = '|| quote_literal(new_name) ||'
	WHERE lower('|| lower(quote_ident(old_col)) ||') ~~ 
    ANY ('||quote_literal(pois_return_search_conditions(new_name,'any'))||')
 	AND
	amenity = '|| quote_literal(old_name)||'';

END;
$function$;
