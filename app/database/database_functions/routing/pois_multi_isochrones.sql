CREATE OR REPLACE FUNCTION public.pois_multi_isochrones(userid_input integer, scenario_id_input integer, minutes integer, speed_input numeric, 
	n integer, routing_profile_input text, alphashape_parameter_input NUMERIC, modus_input integer,region_type text, 
	region text[], amenities text[])
RETURNS SETOF type_pois_multi_isochrones
AS $function$ 
DECLARE 	
 	boundary_envelope numeric[];
 	i integer;
 	points_array numeric[][];
 	objectids_array integer [];
 	mask geometry;
 	buffer_mask geometry;
	buffer integer;
 	excluded_class_id integer[];
	categories_no_foot text[];
	wheelchair_condition text[];
	population_mask jsonb; 
	objectid_multi_isochrone integer;
	max_length_links numeric;
	calc_modus integer;
	excluded_pois_id integer[];
	excluded_buildings_gid integer[];
	BEGIN

	scenario_id_input = COALESCE(scenario_id_input,0);
	
	/*Scenario building has to be implemented*/
	buffer = (minutes::numeric/60::numeric)*speed_input*1000;
 	
	-- Exclude POIs that are not accessible by wheelchair if routing_profile_input = wheelchair
	IF routing_profile_input = 'walking_wheelchair' THEN 
		wheelchair_condition = ARRAY['no','No'];
	ELSE 
		wheelchair_condition = NULL;
	END IF;

	IF modus_input IN(2,4) THEN
		excluded_pois_id = ids_modified_features(scenario_id_input,'pois');
		excluded_buildings_gid = (SELECT deleted_buildings FROM scenarios WHERE scenario_id = scenario_id_input);
	ELSE 
		excluded_pois_id = ARRAY[]::integer[];
		scenario_id_input = 0;
	END IF;

 	IF region_type = 'study_area' THEN
 		--Logic to intersect the amenities with a study area defined by name
		SELECT ST_Union(geom) AS geom, array_to_json(array_agg(jsonb_build_object(name,floor(sum_pop/5)*5))) 
		INTO mask, population_mask
		FROM study_area
		WHERE name IN (SELECT UNNEST(region));
		buffer_mask = ST_buffer(mask::geography,buffer)::geometry;
	
		IF modus_input IN (2,4) THEN
			WITH elements AS 
			(
				SELECT jsonb_object_keys(value) AS _key, value AS elem
				FROM jsonb_array_elements(population_mask)
			),
			population_change AS (
				SELECT s.name, sum(population) AS population
				FROM ( 
					SELECT population, p.geom 
					FROM population_userinput p
					WHERE p.scenario_id = scenario_id_input
					UNION ALL 
					SELECT -population, p.geom 
					FROM population_userinput p
					WHERE p.building_gid IN (SELECT UNNEST(excluded_buildings_gid))
				) x, study_area s
				WHERE ST_Intersects(x.geom,s.geom)
				AND s.name IN (SELECT _key FROM elements)
				GROUP BY s.name
			)
			SELECT array_to_json(array_agg(jsonb_build_object(e._key,(floor(((elem -> e._key)::integer + COALESCE(p.population::integer,0))
			/5)*5)))) 
			INTO population_mask
			FROM elements e
			LEFT JOIN population_change p
			ON p.name = e._key; 
		
	 	END IF;
 	 
 	ELSE 
		mask = st_setsrid(ST_GeomFromText(region[1]), 4326);
		SELECT jsonb_build_object('bounding_box',COALESCE(floor(sum(population)::integer/5)*5,0)) AS sum_pop
		INTO population_mask
		FROM population_userinput p
		WHERE (scenario_id = scenario_id_input OR scenario_id IS NULL)
		AND p.building_gid NOT IN (SELECT UNNEST(excluded_buildings_gid))
		AND ST_Intersects(p.geom,mask);	
	
 		SELECT ST_Buffer(mask::geography,buffer)::geometry 
 		INTO buffer_mask;
	
 	END IF;
 	 	
	SELECT DISTINCT p_array
	INTO points_array
	FROM (
		SELECT array_agg(ARRAY[ST_X(p.geom)::numeric, ST_Y(p.geom)::numeric]) AS p_array
		FROM pois_userinput p
		WHERE p.amenity IN (SELECT UNNEST(amenities))
		--AND p.gid NOT IN (select gid from pois_closed)
		AND (p.scenario_id = scenario_id_input OR p.scenario_id IS NULL)
        AND p.gid NOT IN (SELECT UNNEST(excluded_pois_id))
		AND (p.wheelchair NOT IN (SELECT UNNEST(wheelchair_condition)) OR p.wheelchair IS NULL)
		AND ST_intersects(p.geom, buffer_mask)
	) x;	
 	---------------------------------------------------------------------------------
 	--------------------------get catchment of all starting points-------------------
 	---------------------------------------------------------------------------------
 		
	objectid_multi_isochrone = random_between(1,999999999);
	PERFORM multi_isochrones(userid_input, scenario_id_input, objectid_multi_isochrone, minutes,n,routing_profile_input,speed_input,alphashape_parameter_input,modus_input,1,points_array);
		
	IF region_type = 'study_area' THEN
	 	WITH expand_population AS 
		(
			SELECT m.gid,jsonb_array_elements(population_mask) AS population  
			FROM multi_isochrones m
			WHERE m.objectid = objectid_multi_isochrone 
		),
		iso_intersection AS (
			SELECT m.gid, s.name, ST_Intersection(s.geom,ST_SetSrid(m.geom,4326)) AS geom 
			FROM study_area s, multi_isochrones m
			WHERE s.name IN (SELECT UNNEST(region) AS name)
			AND m.objectid = objectid_multi_isochrone
		),
		reached_population AS (
			SELECT i.gid, i.name, jsonb_build_object(concat(i.name,'_reached'), floor(sum(p.population)::integer/5)*5) reached_population
			FROM iso_intersection i, population_userinput p  
			WHERE ST_intersects(i.geom, p.geom)
			AND p.building_gid NOT IN (SELECT UNNEST(excluded_buildings_gid))
			AND (p.scenario_id = scenario_id_input OR p.scenario_id IS NULL)
			GROUP BY i.gid, i.name
		)
		UPDATE multi_isochrones m
		SET population = x.new_population
		FROM (
			SELECT e.gid, array_to_json(array_agg(e.population|| r.reached_population)) new_population
			FROM expand_population e, reached_population r
			WHERE e.population::jsonb ? r.name
			AND e.gid = r.gid
			GROUP BY e.gid
		) x 
		WHERE m.gid = x.gid;
	
	ELSE 
		UPDATE multi_isochrones 
		SET population = population_mask || reached_population 
		FROM (
			SELECT m.gid, jsonb_build_object('bounding_box_reached',floor(COALESCE(sum(p.population)::integer,0)/5)*5) AS reached_population
			FROM population_userinput p, multi_isochrones m 
			WHERE ST_Intersects(p.geom,ST_Intersection(mask,ST_SetSrid(m.geom,4326)))
			AND m.objectid = objectid_multi_isochrone
			AND p.building_gid NOT IN (SELECT UNNEST(excluded_buildings_gid))
			AND (p.scenario_id = scenario_id_input OR p.scenario_id IS NULL)
			GROUP BY m.gid
		) x
		WHERE multi_isochrones.gid = x.gid;
	
		UPDATE multi_isochrones 
		SET population = population_mask || jsonb_build_object('bounding_box_reached',0)
		WHERE population IS NULL
		AND objectid = objectid_multi_isochrone;
	
	END IF; 
	RETURN query 
	SELECT gid,objectid, coordinates, userid, scenario_id_input, step, routing_profile, speed, alphashape_parameter,modus, parent_id, population, geom geometry 
	FROM multi_isochrones
	WHERE objectid = objectid_multi_isochrone;
	END;
$function$ LANGUAGE plpgsql;

/*
SELECT *
FROM pois_multi_isochrones(1,15,5.0,3,'walking_wheelchair',0.00003,1,'study_area',ARRAY['16.3','16.4'],ARRAY['supermarket','bar']) ;

SELECT *
FROM pois_multi_isochrones(1,10,5.0,2,'walking_standard',0.00003,1,'envelope',array['11.599198','48.130329','11.630676','48.113260'],array['supermarket','discount_supermarket']) 
--alphashape_parameter NUMERIC = 0.00003;
--region_type 'envelope' or study_area
*/

