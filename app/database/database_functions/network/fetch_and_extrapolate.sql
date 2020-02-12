DROP FUNCTION IF EXISTS fetch_ways_routing;
CREATE OR REPLACE FUNCTION public.fetch_ways_routing(buffer_geom text, speed_input numeric, modus_input integer, userid_input integer, routing_profile text)
 RETURNS SETOF type_fetch_ways_routing
 LANGUAGE plpgsql
AS $function$
DECLARE 
	excluded_ways_id text;
	sql_ways_ids text := '';
	sql_userid text := '';
	sql_routing_profile text := '';
	table_name text := 'ways';
	excluded_class_id integer[];
	filter_categories text[];
	category text := jsonb_build_object('walking','foot','cycling','bicycle') ->>  split_part(routing_profile,'_',1);
	sql_cost text := jsonb_build_object(
	'cycling','length_m*(1+COALESCE(s_imp,0)+COALESCE(impedance_surface,0))::float as cost,length_m*(1+COALESCE(rs_imp,0)+COALESCE(impedance_surface,0))::float as reverse_cost',
	'walking', 'length_m as cost, length_m as reverse_cost'
	) ->> split_part(routing_profile,'_',1);
	userid_vertex integer;
	
BEGIN 

	excluded_class_id = select_from_variable_container('excluded_class_id_' || split_part(routing_profile,'_',1));
  	filter_categories = select_from_variable_container('categories_no_' || category);

	IF modus_input <> 1 THEN 
		table_name = 'ways_userinput';
		excluded_ways_id = ids_modified_features(userid_input,'ways');

		sql_userid = ' AND userid IS NULL OR userid='||userid_input;
		sql_ways_ids = ' AND NOT id::int4 = any('''|| excluded_ways_id ||''') ';
	END IF;
	
	IF  routing_profile = 'walking_safe_night' THEN
		sql_routing_profile = 'AND (lit_classified = ''yes'' OR lit_classified = ''unclassified'')';
	ELSEIF routing_profile = 'walking_wheelchair' THEN
		sql_routing_profile = 'AND ((wheelchair_classified = ''yes'') OR wheelchair_classified = ''limited''
		OR wheelchair_classified = ''unclassified'')';
	END IF;
	RAISE NOTICE '%',sql_cost;
	RETURN query EXECUTE '
		SELECT  id::integer, source, target,'||sql_cost||',slope_profile,death_end,geom 
		FROM '||quote_ident(table_name)||
		' WHERE class_id NOT IN(SELECT UNNEST($1))
    	AND (foot NOT IN(SELECT UNNEST($2)) OR foot IS NULL)
		AND geom && ST_GeomFromText($3)'||sql_userid||sql_ways_ids||sql_routing_profile
	USING excluded_class_id, filter_categories,buffer_geom;
END;
$function$;


/*select fetch_ways_routing(ST_ASTEXT(ST_BUFFER(ST_POINT(11.543274,48.195524),0.001)),1.33,1,1,'walking_standard');
*/

DROP FUNCTION IF EXISTS get_reached_network;
CREATE OR REPLACE FUNCTION public.get_reached_network(objectid_input integer,max_cost NUMERIC, number_isochrones integer)
RETURNS void AS
$$
DECLARE
	i NUMERIC;
	step_isochrone NUMERIC := max_cost/number_isochrones;
BEGIN
	INSERT INTO edges(edge,node,cost,geom,v_geom,objectid) 
	SELECT w.id,s.node,s.cost,w.geom,s.geom AS v_geom,objectid_input
	FROM temp_reached_vertices f, temp_reached_vertices s, temp_fetched_ways w 
	WHERE f.node = w.source 
	AND s.node = w.target;
	
	FOR i IN SELECT generate_series(step_isochrone,max_cost,step_isochrone)
	LOOP
		INSERT INTO edges 
		SELECT x.id AS edge, x.node, i AS cost, ST_LINE_SUBSTRING(x.geom,1-((i-x.agg_cost)/x.cost),1) AS geom,
		ST_STARTPOINT(ST_LINE_SUBSTRING(x.geom,1-((i-x.agg_cost)/x.cost),1)) AS v_geom, objectid_input 
		FROM 
		(
			SELECT w.id, v.node, v.cost agg_cost, w.cost, w.geom
			FROM temp_reached_vertices v, temp_fetched_ways w
			WHERE v.node = w.target
			AND w.death_end IS NULL 
			AND v.cost < i
		) x
		LEFT JOIN (SELECT edge FROM edges e WHERE e.objectid = objectid_input AND cost < i) e
		ON x.id = e.edge 
		WHERE e.edge IS NULL
		UNION ALL 
		SELECT x.id AS edge, x.node, i AS cost, ST_LINE_SUBSTRING(x.geom,0,((i-x.agg_cost)/x.cost)) AS geom,
		ST_ENDPOINT(ST_LINE_SUBSTRING(x.geom,0,(i-x.agg_cost)/x.cost)) AS v_geom, objectid_input 
		FROM 
		(
			SELECT w.id, v.node, v.cost agg_cost, w.cost, w.geom 
			FROM temp_reached_vertices v, temp_fetched_ways w
			WHERE v.node = w.source
			AND w.death_end IS NULL 
			AND v.cost < i
		) x
		LEFT JOIN (SELECT edge FROM edges e WHERE e.objectid = objectid_input AND cost < i) e
		ON x.id = e.edge 
		WHERE e.edge IS NULL;
	
	END LOOP;
		
	INSERT INTO edges	
	SELECT w.id AS edge,v.node,CASE WHEN w.SOURCE = v.node THEN v.cost + w.cost ELSE v.cost + w.reverse_cost END AS cost, 
	w.geom,CASE WHEN w.source = v.node THEN ST_ENDPOINT(w.geom) ELSE ST_STARTPOINT(w.geom) END AS v_geom,objectid_input
	FROM temp_reached_vertices v, temp_fetched_ways w 
	WHERE v.death_end = TRUE 
	AND v.node = w.death_end
	AND w.cost < (max_cost-v.cost);
END;
$$ LANGUAGE plpgsql;